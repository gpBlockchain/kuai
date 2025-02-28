import { execSync } from 'node:child_process'
import read from 'read'
import { existsSync, writeFileSync, cpSync, rmSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { KuaiError, KuaiContractLoader, ContractManager, configPath } from '@ckb-js/kuai-common'
import { ERRORS } from '../errors-list'
import type { FromInfo, MultisigScript } from '@ckb-lumos/common-scripts'
import { parseFromInfo } from '@ckb-lumos/common-scripts'
import { encodeToAddress, scriptToAddress } from '@ckb-lumos/helpers'
import { Config } from '@ckb-lumos/config-manager'
import { ParamsFormatter } from '@ckb-lumos/rpc'
import { ContractDeployer } from '../contract'
import type { MessageSigner } from '../contract'
import { signMessageByCkbCli } from '../ckb-cli'
import { task, subtask } from '../config/config-env'
import { paramTypes } from '../params'
import { getUserConfigPath } from '../project-structure'
import { getGenesisScriptsConfig } from '../util/chain'
import { generateMigrationFileName, findMigrationByDir } from '../util/contract-migration'
import { Path } from '@ckb-js/kuai-common/lib/contract/path'

task('contract').setAction(async () => {
  execSync('kuai contract --help', { stdio: 'inherit' })
})

interface ContractDeployArgs {
  name?: string
  binPath?: string
  from: string[]
  signer?: 'ckb-cli' | 'ckb-cli-multisig'
  feeRate?: number
  export?: string
  migrationDir?: string
  noTypeId: boolean
}

function isMultisigFromInfo(fromInfo: FromInfo): fromInfo is MultisigScript {
  if (typeof fromInfo !== 'object') return false
  return 'M' in fromInfo && 'R' in fromInfo && Array.isArray(fromInfo.publicKeyHashes)
}

function parseFromInfoByCli(info: string[]): FromInfo[] {
  if (info[0] === 'multisig') {
    if (!info[1] || !Number.isInteger(parseInt(info[1]))) {
      throw new KuaiError(ERRORS.ARGUMENTS.INVALID_VALUE_FOR_TYPE, {
        name: 'r',
        value: info[1],
        type: 'number',
      })
    }

    if (!info[2] || !Number.isInteger(parseInt(info[2]))) {
      throw new KuaiError(ERRORS.ARGUMENTS.INVALID_VALUE_FOR_TYPE, {
        name: 'm',
        value: info[2],
        type: 'number',
      })
    }

    const hashes = info.slice(3)

    if (hashes.length === 0) {
      throw new KuaiError(ERRORS.ARGUMENTS.MISSING_TASK_ARGUMENT, {
        param: 'multisig hashes',
      })
    }

    return [
      {
        R: parseInt(info[1]),
        M: parseInt(info[2]),
        publicKeyHashes: hashes,
      },
    ]
  }

  return info
}

subtask('contract:deploy')
  .addParam('name', 'name of the contract to be deployed', '', paramTypes.string, true)
  .addParam('bin-path', 'path of contract bin file', '', paramTypes.path, true)
  .addParam('from', 'address or multisig config of the contract deployer', undefined, paramTypes.string, false, true)
  .addParam('signer', 'signer provider [possible values: ckb-cli, ckb-cli-multisig]', '', paramTypes.string, true)
  .addParam(
    'fee-rate',
    "per transaction's fee, deployment may involve more than one transaction. default: [1000] shannons/Byte",
    1000,
    paramTypes.number,
    true,
  )
  .addParam('export', 'export transaction to file', '', paramTypes.path, true)
  .addParam('no-type-id', 'not use type id deploy', false, paramTypes.boolean, true)
  .addParam('migration-dir', 'migration directory for saving json format migration files', '', paramTypes.path, true)
  .setAction(async (args: ContractDeployArgs, { config, run }) => {
    const { name, from, feeRate, signer, binPath, noTypeId = false, migrationDir } = args
    const { ckbChain } = config

    const fromInfos = parseFromInfoByCli(from)

    const nameOrBinPath = name || binPath

    if (!nameOrBinPath) {
      throw new KuaiError(ERRORS.BUILTIN_TASKS.NOT_SPECIFY_CONTRACT)
    }

    const conrtactBinPath = await (async () => {
      // check bin path is absolute path
      if (binPath && path.isAbsolute(binPath)) {
        return binPath
      }

      if (binPath) {
        return path.join(process.cwd(), binPath)
      }

      const workspace = (await run('contract:get-workspace')) as string

      return path.join(workspace, `build/release/${name}`)
    })()

    if (!existsSync(conrtactBinPath)) {
      throw new KuaiError(ERRORS.BUILTIN_TASKS.CONTRACT_RELEASE_FILE_NOT_FOUND, {
        var: name,
      })
    }

    const lumosConfig: Config = {
      PREFIX: ckbChain.prefix,
      SCRIPTS: ckbChain.scripts || {
        ...(await getGenesisScriptsConfig(ckbChain.rpcUrl)),
      },
    }

    const messageSigner: MessageSigner = (message, fromInfo) => {
      const { multisigScript } = parseFromInfo(fromInfo, { config: lumosConfig })
      return run('contract:sign-message', {
        message,
        address: encodeToAddress(parseFromInfo(fromInfo, { config: lumosConfig }).fromScript, { config: lumosConfig }),
        signer,
        prefix: multisigScript,
      }) as Promise<string>
    }

    const deployer = new ContractDeployer(
      {
        rpcUrl: config.ckbChain.rpcUrl,
        config: lumosConfig,
      },
      signer ? messageSigner : undefined,
    )

    const {
      tx,
      index,
      dataHash,
      typeId,
      hashType,
      depType,
      send: sendTx,
    } = await deployer.deploy(conrtactBinPath, fromInfos[0], { feeRate, enableTypeId: !noTypeId })

    if (args.export) {
      const exportPath = path.isAbsolute(args.export) ? args.export : path.join(process.cwd(), args.export)

      const exportData = {
        transaction: ParamsFormatter.toRawTransaction(tx),
        multisig_configs: {},
        signatures: {},
      }

      fromInfos.forEach((fromInfo) => {
        if (isMultisigFromInfo(fromInfo)) {
          const { fromScript } = parseFromInfo(fromInfo, { config: lumosConfig })
          const template = lumosConfig.SCRIPTS['SECP256K1_BLAKE160']!
          Object.assign(exportData.multisig_configs, {
            [fromScript.args]: {
              sighash_addresses: fromInfo.publicKeyHashes.map((args) =>
                scriptToAddress(
                  {
                    codeHash: template.CODE_HASH,
                    hashType: template.HASH_TYPE,
                    args: args,
                  },
                  { config: lumosConfig },
                ),
              ),
              require_first_n: fromInfo.R,
              threshold: fromInfo.M,
            },
          })
        }
      })

      writeFileSync(exportPath, JSON.stringify(exportData, null, 2))
    } else {
      const txHash = await sendTx()
      console.info('deploy success, txHash: ', txHash)
      if (migrationDir) {
        const _migrationPath = path.isAbsolute(migrationDir) ? migrationDir : path.join(process.cwd(), migrationDir)

        if (!existsSync(_migrationPath)) {
          mkdirSync(_migrationPath)
        }

        const migrationFileName = generateMigrationFileName()
        const migrationData = {
          cell_recipes: [
            {
              name: nameOrBinPath,
              tx_hash: txHash,
              index: index,
              data_hash: dataHash,
              type_id: typeId,
            },
          ],
        }

        writeFileSync(path.join(_migrationPath, migrationFileName), JSON.stringify(migrationData, null, 2))
      }

      const contractManager = new ContractManager([
        new KuaiContractLoader(config.devNode?.builtInContractConfigPath ?? path.resolve(configPath(), 'scripts.json')),
      ])

      contractManager.updateContract({
        name: nameOrBinPath,
        path: new Path(conrtactBinPath),
        scriptBase: {
          codeHash: dataHash,
          hashType: hashType,
        },
        outPoint: {
          txHash: txHash,
          index: '0x' + index.toString(16),
        },
        depType: depType,
      })

      contractManager.write()
    }

    return tx
  })

interface ContractUpgradeArgs {
  name?: string
  binPath?: string
  migrationDir: string
  signer?: 'ckb-cli' | 'ckb-cli-multisig'
  feePayer?: string[]
  deployer?: string[]
  feeRate?: number
  export?: string
}
subtask('contract:upgrade')
  .addParam('name', 'name of the contract to upgrade', '', paramTypes.string, true)
  .addParam('bin-path', 'path of contract bin file', '', paramTypes.path, true)
  .addParam('migration-dir', 'path of migration file')
  .addParam(
    'fee-payer',
    'address or multisig config of the transaction fee payer',
    undefined,
    paramTypes.string,
    true,
    true,
  )
  .addParam(
    'deployer',
    'address or multisig config of the contract deployer',
    undefined,
    paramTypes.string,
    false,
    true,
  )
  .addParam('signer', 'signer provider [possible values: ckb-cli, ckb-cli-multisig]', '', paramTypes.string, true)
  .addParam(
    'fee-rate',
    "per transaction's fee, deployment may involve more than one transaction. default: [1000] shannons/Byte",
    1000,
    paramTypes.number,
    true,
  )
  .addParam('export', 'export transaction to file', '', paramTypes.path, true)
  .setAction(async (args: ContractUpgradeArgs, { config, run }) => {
    const { name, feePayer, deployer, feeRate, signer, binPath, migrationDir } = args
    const { ckbChain } = config

    const deployerInfos = deployer ? parseFromInfoByCli(deployer) : []
    const feePayerInfos = feePayer ? parseFromInfoByCli(feePayer) : deployerInfos

    const targetContractName = name || binPath

    if (!targetContractName) {
      throw new KuaiError(ERRORS.BUILTIN_TASKS.NOT_SPECIFY_CONTRACT)
    }

    const _migrationPath = path.isAbsolute(migrationDir) ? migrationDir : path.join(process.cwd(), migrationDir)
    if (!existsSync(_migrationPath)) {
      throw new KuaiError(ERRORS.BUILTIN_TASKS.CONTRACT_MIGRATION_DIRECTORY_NOT_FOUND, {
        var: name,
      })
    }

    const migration = findMigrationByDir(_migrationPath, targetContractName)
    if (!migration) {
      throw new KuaiError(ERRORS.BUILTIN_TASKS.INVALID_CONTRACT_MIGRATION_FILE, {
        var: name,
      })
    }

    const conrtactBinPath = await (async () => {
      // check bin path is absolute path
      if (binPath && path.isAbsolute(binPath)) {
        return binPath
      }

      if (binPath) {
        return path.join(process.cwd(), binPath)
      }

      const workspace = (await run('contract:get-workspace')) as string

      return path.join(workspace, `build/release/${name}`)
    })()

    if (!existsSync(conrtactBinPath)) {
      throw new KuaiError(ERRORS.BUILTIN_TASKS.CONTRACT_RELEASE_FILE_NOT_FOUND, {
        var: name,
      })
    }

    const lumosConfig: Config = {
      PREFIX: ckbChain.prefix,
      SCRIPTS: ckbChain.scripts || {
        ...(await getGenesisScriptsConfig(ckbChain.rpcUrl)),
      },
    }

    const messageSigner: MessageSigner = (message, fromInfo) => {
      const { multisigScript } = parseFromInfo(fromInfo, { config: lumosConfig })
      return run('contract:sign-message', {
        message,
        address: encodeToAddress(parseFromInfo(fromInfo, { config: lumosConfig }).fromScript, { config: lumosConfig }),
        signer,
        prefix: multisigScript,
      }) as Promise<string>
    }

    const contractDeployer = new ContractDeployer(
      {
        rpcUrl: config.ckbChain.rpcUrl,
        config: lumosConfig,
      },
      signer ? messageSigner : undefined,
    )

    const {
      tx,
      index,
      dataHash,
      typeId,
      hashType,
      depType,
      send: sendTx,
    } = await contractDeployer.upgrade(
      conrtactBinPath,
      deployerInfos[0],
      feePayerInfos[0],
      {
        txHash: migration.tx_hash,
        index: migration.index,
        dataHash: migration.data_hash,
      },
      { feeRate },
    )

    if (args.export) {
      const exportPath = path.isAbsolute(args.export) ? args.export : path.join(process.cwd(), args.export)

      const exportData = {
        transaction: ParamsFormatter.toRawTransaction(tx),
        multisig_configs: {},
        signatures: {},
      }

      const infos = [...feePayerInfos, ...deployerInfos]
      infos.forEach((fromInfo) => {
        if (isMultisigFromInfo(fromInfo)) {
          const { fromScript } = parseFromInfo(fromInfo, { config: lumosConfig })
          const template = lumosConfig.SCRIPTS['SECP256K1_BLAKE160']!
          Object.assign(exportData.multisig_configs, {
            [fromScript.args]: {
              sighash_addresses: fromInfo.publicKeyHashes.map((args) =>
                scriptToAddress(
                  {
                    codeHash: template.CODE_HASH,
                    hashType: template.HASH_TYPE,
                    args: args,
                  },
                  { config: lumosConfig },
                ),
              ),
              require_first_n: fromInfo.R,
              threshold: fromInfo.M,
            },
          })
        }
      })

      writeFileSync(exportPath, JSON.stringify(exportData, null, 2))
    } else {
      const txHash = await sendTx()
      console.info('deploy success, txHash: ', txHash)

      // generate migration file
      const migrationFileName = generateMigrationFileName()
      const migrationData = {
        cell_recipes: [
          {
            name: targetContractName,
            tx_hash: txHash,
            index: index,
            data_hash: dataHash,
            type_id: typeId,
          },
        ],
      }

      writeFileSync(path.join(_migrationPath, migrationFileName), JSON.stringify(migrationData, null, 2))

      const contractManager = new ContractManager([
        new KuaiContractLoader(config.devNode?.builtInContractConfigPath ?? path.resolve(configPath(), 'scripts.json')),
      ])

      contractManager.updateContract({
        name: targetContractName,
        path: new Path(conrtactBinPath),
        scriptBase: {
          codeHash: dataHash,
          hashType: hashType,
        },
        outPoint: {
          txHash: txHash,
          index: '0x' + index.toString(16),
        },
        depType: depType,
      })

      contractManager.write()
    }

    return tx
  })

subtask('contract:sign-message')
  .addParam('message', 'message to be signed', '', paramTypes.string, false)
  .addParam('address', 'the address of message signer', '', paramTypes.string, false)
  .addParam('prefix', 'the prefix of signature', '', paramTypes.string, true)
  .addParam(
    'signer',
    'signer provider [default: ckb-cli] [possible values: ckb-cli, ckb-cli-multisig]',
    'ckb-cli',
    paramTypes.string,
    true,
  )
  .setAction(async ({ message, address, prefix = '', signer }): Promise<string> => {
    if (signer === 'ckb-cli') {
      const password = await read({ prompt: `Input ${address}'s password for sign messge by ckb-cli:`, silent: true })
      console.info('')
      return signMessageByCkbCli(message, address, password)
    }

    if (signer === 'ckb-cli-multisig') {
      const preSigningAddresses = (
        await read({ prompt: `Input the signing addresses or args for sign multisig, separated by spaces: ` })
      ).split(' ')
      if (!Array.isArray(preSigningAddresses) || preSigningAddresses.length === 0) {
        throw new KuaiError(ERRORS.BUILTIN_TASKS.NOT_SPECIFY_SIGNING_ADDRESS)
      }

      let multisigs: string[] = []
      for (const addr of preSigningAddresses) {
        const password = await read({ prompt: `Input ${addr}'s password for sign messge by ckb-cli:`, silent: true })
        console.info('')
        const sig = signMessageByCkbCli(message, addr, password).slice(2)
        multisigs = [...multisigs, sig]
      }

      return `${prefix}${multisigs.join('')}`
    }

    throw new KuaiError(ERRORS.BUILTIN_TASKS.UNSUPPORTED_SIGNER, {
      var: signer,
    })
  })

subtask('contract:get-workspace').setAction(async (_, { config }) => {
  if (config.contract?.workspace) {
    return config.contract?.workspace
  }

  const userConfigPath = getUserConfigPath()
  if (!userConfigPath) {
    throw new Error('Please run in kuai project')
  }

  return path.join(path.dirname(userConfigPath), 'contract')
})

subtask('contract:set-environment').setAction(async () => {
  // todo: download ckb-cli & capsule etc...
})

interface BuildArgs {
  name?: string
  release?: boolean
}

subtask('contract:build')
  .addParam('name', 'contract name', '', paramTypes.string, true)
  .addParam('release', 'build contracts in release mode', false, paramTypes.boolean, true)
  .setAction(async ({ name, release }: BuildArgs, { run }) => {
    const workspace = await run('contract:get-workspace')
    execSync(`cd ${workspace} && capsule build${name ? ` --name ${name}` : ''}${release ? ' --release' : ''}`, {
      stdio: 'inherit',
    })
  })

interface NewArgs {
  name: string
  template: string
}

subtask('contract:new')
  .addParam('name', 'The name of new contract')
  .addParam(
    'template',
    'language template  [default: rust]  [possible values: rust, c, c-sharedlib]',
    'rust',
    paramTypes.string,
    true,
  )
  .setAction(async ({ name, template }: NewArgs, { run }) => {
    const workspace = await run('contract:get-workspace')
    execSync(`cd ${workspace} && capsule new-contract ${name} --template ${template}`, { stdio: 'inherit' })
  })

interface InitArgs {
  name: string
  template: string
}

subtask('contract:init')
  .addParam('name', 'The name of new contract project')
  .addParam(
    'template',
    'language template  [default: rust]  [possible values: rust, c, c-sharedlib]',
    'rust',
    paramTypes.string,
    true,
  )
  .setAction(async ({ name, template }: InitArgs, { run }) => {
    const workspace = (await run('contract:get-workspace')) as string
    const newProjectPath = path.join(workspace, '..', name)
    execSync(`capsule new ${name} --template ${template}`, { stdio: 'inherit' })

    // remove .git file
    rmSync(path.join(newProjectPath, '.git'), { recursive: true })

    // copy project to workspace directory
    cpSync(newProjectPath, workspace, { recursive: true })

    // remove temp files
    rmSync(newProjectPath, { recursive: true })
  })
