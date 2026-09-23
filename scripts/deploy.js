import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  http,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'

const RPC_URL = 'http://127.0.0.1:8545'
const LOCAL_CHAIN_ID = 31337
const ANVIL_ACCOUNT_ZERO_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const projectDirectory = resolve(scriptDirectory, '..')
const artifactPath = resolve(
  projectDirectory,
  'blockchain',
  'out',
  'OnChainMessageBoard.sol',
  'OnChainMessageBoard.json',
)
const frontendConfigPath = resolve(
  projectDirectory,
  'frontend',
  'contract.json',
)

function requireHexBytecode(artifact) {
  const object = artifact?.bytecode?.object
  if (!object || object === '0x') {
    throw new Error(`Compiled bytecode was not found in ${artifactPath}`)
  }
  return object.startsWith('0x') ? object : `0x${object}`
}

async function main() {
  if (process.argv.length > 2) {
    throw new Error(
      'This lab uses one command only: yarn deploy. Do not pass extra arguments.',
    )
  }

  console.log('Deploying to the local Anvil chain...')
  console.log('WARNING: This uses a publicly known Anvil test key. Never use it on a real network.')

  const artifact = JSON.parse(await readFile(artifactPath, 'utf8'))
  const bytecode = requireHexBytecode(artifact)
  const privateKey = process.env.ANVIL_PRIVATE_KEY || ANVIL_ACCOUNT_ZERO_PRIVATE_KEY
  const account = privateKeyToAccount(privateKey)
  const transport = http(RPC_URL)
  const publicClient = createPublicClient({ chain: foundry, transport })
  const walletClient = createWalletClient({ account, chain: foundry, transport })

  const chainId = await publicClient.getChainId()
  if (chainId !== LOCAL_CHAIN_ID) {
    throw new Error(`Expected local chain ID ${LOCAL_CHAIN_ID}, received ${chainId}.`)
  }

  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    account,
    bytecode,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  const address = receipt.contractAddress
  if (!address) throw new Error('Deployment receipt did not contain a contract address.')

  const count = await publicClient.readContract({
    address,
    abi: artifact.abi,
    functionName: 'messageCount',
  })
  const [, initialMessage] = await publicClient.readContract({
    address,
    abi: artifact.abi,
    functionName: 'getMessage',
    args: [0n],
  })
  if (count !== 1n) throw new Error('The deployed contract did not store its default message.')

  const frontendConfig = {
    chainId,
    address,
    deployer: account.address,
    deploymentTransaction: hash,
    deploymentBlock: receipt.blockNumber.toString(),
    abi: artifact.abi,
  }

  await mkdir(dirname(frontendConfigPath), { recursive: true })
  await writeFile(
    frontendConfigPath,
    `${JSON.stringify(frontendConfig, null, 2)}\n`,
    'utf8',
  )

  console.log('Deployment successful.')
  console.log(`Contract: ${address}`)
  console.log(`Transaction: ${hash}`)
  console.log(`Block: ${receipt.blockNumber}`)
  console.log(`Initial message: ${initialMessage}`)
  console.log('The frontend deployment file is ready. Open or refresh the webpage.')
}

main().catch((error) => {
  console.error(`Deployment failed: ${error.shortMessage || error.message}`)
  process.exitCode = 1
})
