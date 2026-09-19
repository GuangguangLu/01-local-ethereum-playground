import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  parseEther,
  decodeFunctionData,
} from 'viem'
import { foundry } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

const RPC_URL = 'http://127.0.0.1:8545'
const POLL_INTERVAL = 2000
const MAX_MESSAGE_BYTES = 280

let publicClient = null
let walletClient = null
let currentAccount = null
let contractConfig = null
let contractAvailable = false
let contractInitialMessage = null
let highestKnownBlock = -1n
let pollingTimer = null
const balanceCache = new Map()

const $ = (id) => document.getElementById(id)

async function initPublicClient() {
  publicClient = createPublicClient({
    chain: foundry,
    transport: http(RPC_URL),
  })

  try {
    const chainId = await publicClient.getChainId()
    $('chain-id').textContent = chainId
    $('rpc-status').textContent = 'Connected'
    $('rpc-status').className = 'connected'
    setExplorerConnection(true)
    return true
  } catch {
    $('rpc-status').textContent = 'Disconnected'
    $('rpc-status').className = 'disconnected'
    setExplorerConnection(false)
    return false
  }
}

async function updateBlockchainStatus() {
  try {
    const blockNumber = await publicClient.getBlockNumber({ cacheTime: 0 })
    $('latest-block').textContent = `#${blockNumber}`
    $('total-blocks').textContent = `${blockNumber + 1n}`
    $('rpc-status').textContent = 'Connected'
    $('rpc-status').className = 'connected'
    return blockNumber
  } catch {
    $('rpc-status').textContent = 'Disconnected'
    $('rpc-status').className = 'disconnected'
    return null
  }
}

function handleLogin() {
  const addressInput = $('wallet-address').value.trim()
  const pkInput = $('private-key').value.trim()
  $('login-error').textContent = ''

  if (!addressInput || !pkInput) {
    $('login-error').textContent = 'Please enter both address and private key.'
    return
  }

  const privateKey = pkInput.startsWith('0x') ? pkInput : `0x${pkInput}`
  let account
  try {
    account = privateKeyToAccount(privateKey)
  } catch {
    $('login-error').textContent = 'Invalid private key format.'
    return
  }

  if (account.address.toLowerCase() !== addressInput.toLowerCase()) {
    $('login-error').textContent = 'Private key does not match this wallet address.'
    return
  }

  currentAccount = account
  walletClient = createWalletClient({
    account: currentAccount,
    chain: foundry,
    transport: http(RPC_URL),
  })

  $('login-form').classList.add('hidden')
  $('wallet-info').classList.remove('hidden')
  $('connected-address').textContent = currentAccount.address
  $('send-section').classList.remove('hidden')
  $('send-from').value = currentAccount.address
  updateContractWriteState()
}

function handleLogout() {
  currentAccount = null
  walletClient = null
  $('login-form').classList.remove('hidden')
  $('wallet-info').classList.add('hidden')
  $('send-section').classList.add('hidden')
  $('wallet-address').value = ''
  $('private-key').value = ''
  $('login-error').textContent = ''
  $('send-status').textContent = ''
  $('send-error').textContent = ''
  updateContractWriteState()
}

async function handleSendTransaction() {
  const to = $('send-to').value.trim()
  const amountString = $('send-amount').value.trim()
  $('send-error').textContent = ''
  $('send-status').textContent = ''

  if (!to || !amountString) {
    $('send-error').textContent = 'Please enter recipient address and amount.'
    return
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    $('send-error').textContent = 'Invalid recipient address.'
    return
  }

  let value
  try {
    value = parseEther(amountString)
  } catch {
    $('send-error').textContent = 'Invalid ETH amount.'
    return
  }

  const sendButton = $('send-btn')
  sendButton.disabled = true
  $('send-status').textContent = 'Sending transaction…'

  try {
    const hash = await walletClient.sendTransaction({ to, value })
    $('send-status').textContent = 'Waiting for confirmation…'
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    $('send-status').textContent = receipt.status === 'success'
      ? `Confirmed in block #${receipt.blockNumber}.`
      : `Transaction failed in block #${receipt.blockNumber}.`
  } catch (error) {
    $('send-error').textContent = `Transaction failed: ${error.shortMessage || error.message}`
    $('send-status').textContent = ''
  } finally {
    sendButton.disabled = false
  }
}

function setContractStatus(message, variant = '') {
  const status = $('contract-status')
  status.textContent = message
  status.className = `contract-status${variant ? ` ${variant}` : ''}`
}

function messageByteLength(text) {
  return new TextEncoder().encode(text).length
}

function updateContractWriteState() {
  const message = $('contract-message').value
  const bytes = messageByteLength(message)
  const validMessage = message.trim().length > 0 && bytes <= MAX_MESSAGE_BYTES
  const canWrite = Boolean(currentAccount && walletClient && contractAvailable)

  $('contract-message-bytes').textContent = `${bytes} / ${MAX_MESSAGE_BYTES} bytes`
  $('contract-message-bytes').classList.toggle('over-limit', bytes > MAX_MESSAGE_BYTES)
  $('contract-write-btn').disabled = !canWrite || !validMessage

  if (!contractAvailable) {
    $('contract-write-help').textContent = 'Deploy the contract with yarn deploy before writing.'
  } else if (!currentAccount) {
    $('contract-write-help').textContent = 'Login with a local test wallet to write.'
  } else if (bytes > MAX_MESSAGE_BYTES) {
    $('contract-write-help').textContent = 'Message is too long. The contract accepts at most 280 UTF-8 bytes.'
  } else {
    $('contract-write-help').textContent = 'This write costs local test gas and creates a new block.'
  }
}

function showMissingContract(message) {
  contractAvailable = false
  contractConfig = null
  contractInitialMessage = null
  $('contract-empty').classList.remove('hidden')
  $('contract-content').classList.add('hidden')
  $('contract-empty').querySelector('strong').textContent = 'No active deployment found'
  $('contract-empty').querySelector('p').textContent = message
  updateContractWriteState()
}

function shortenHex(value, startLength = 8, endLength = 6) {
  if (!value) return 'Unavailable'
  if (value.length <= startLength + endLength + 1) return value
  return `${value.slice(0, startLength)}…${value.slice(-endLength)}`
}

async function readContractSummary() {
  if (!contractAvailable || !contractConfig) return
  $('contract-refresh-btn').disabled = true
  setContractStatus('Reading chain…')

  try {
    const count = await publicClient.readContract({
      address: contractConfig.address,
      abi: contractConfig.abi,
      functionName: 'messageCount',
    })
    const [, initialMessage] = await publicClient.readContract({
      address: contractConfig.address,
      abi: contractConfig.abi,
      functionName: 'getMessage',
      args: [0n],
    })
    contractInitialMessage = initialMessage
    setContractStatus(
      `${count} message${count === 1n ? '' : 's'} · shown in blocks`,
      'ready'
    )
  } catch {
    showMissingContract('The saved address has no compatible contract on this Anvil chain. Anvil may have restarted; run yarn deploy again.')
    setContractStatus('Deployment is stale', 'error')
  } finally {
    $('contract-refresh-btn').disabled = false
  }
}

async function loadContractConfig() {
  setContractStatus('Checking deployment…')
  $('contract-error').textContent = ''

  try {
    const response = await fetch(`./contract.json?time=${Date.now()}`, { cache: 'no-store' })
    if (!response.ok) throw new Error('missing-config')
    const config = await response.json()

    if (
      Number(config.chainId) !== foundry.id ||
      !/^0x[0-9a-fA-F]{40}$/.test(config.address) ||
      !Array.isArray(config.abi)
    ) {
      throw new Error('invalid-config')
    }

    const bytecode = await publicClient.getBytecode({ address: config.address })
    if (!bytecode || bytecode === '0x') {
      showMissingContract('The deployment belongs to an earlier Anvil session. Run yarn deploy again for the current chain.')
      setContractStatus('Deployment is stale', 'error')
      return
    }

    contractConfig = config
    contractAvailable = true
    $('contract-empty').classList.add('hidden')
    $('contract-content').classList.remove('hidden')
    $('contract-address').textContent = config.address
    $('contract-address').title = config.address
    $('contract-deployment-tx').textContent = config.deploymentTransaction
    $('contract-deployment-tx').title = config.deploymentTransaction
    $('contract-deployment-block').textContent = `#${config.deploymentBlock}`
    updateContractWriteState()
    await readContractSummary()
    if (highestKnownBlock >= 0n) await fetchInitialBlocks()
  } catch (error) {
    const message = error.message === 'missing-config'
      ? 'No deployment file exists yet. Edit NAME in the Solidity contract, then run yarn deploy.'
      : 'The deployment file is invalid. Run yarn deploy to regenerate it.'
    showMissingContract(message)
    setContractStatus('Not deployed', 'error')
  }
}

async function handleStoreMessage() {
  if (!currentAccount || !walletClient || !contractAvailable) {
    updateContractWriteState()
    return
  }

  const text = $('contract-message').value
  const bytes = messageByteLength(text)
  $('contract-error').textContent = ''
  $('contract-write-status').textContent = ''

  if (!text.trim() || bytes > MAX_MESSAGE_BYTES) {
    $('contract-error').textContent = 'Enter a message between 1 and 280 UTF-8 bytes.'
    return
  }

  const button = $('contract-write-btn')
  button.disabled = true
  $('contract-write-status').textContent = 'Sending transaction…'

  try {
    const hash = await walletClient.writeContract({
      address: contractConfig.address,
      abi: contractConfig.abi,
      functionName: 'store',
      args: [text],
    })
    $('contract-write-status').textContent = 'Waiting for confirmation…'
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error('Transaction reverted')

    $('contract-message').value = ''
    $('contract-write-status').textContent = `Stored permanently in block #${receipt.blockNumber}.`
    await readContractSummary()
    await fetchInitialBlocks()
  } catch (error) {
    $('contract-write-status').textContent = ''
    $('contract-error').textContent = `Write failed: ${error.shortMessage || error.message}`
  } finally {
    updateContractWriteState()
  }
}

function formatEthValue(value) {
  const [whole, fraction = ''] = formatEther(value ?? 0n).split('.')
  const shortFraction = fraction.slice(0, 6).replace(/0+$/, '')
  return shortFraction ? `${whole}.${shortFraction}` : whole
}

function formatBalance(value) {
  return value === null ? 'Unavailable' : `${formatEthValue(value)} ETH`
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function getContractActivity(transaction) {
  if (!contractAvailable || !contractConfig) return null

  if (
    transaction.hash.toLowerCase() ===
    contractConfig.deploymentTransaction.toLowerCase()
  ) {
    return {
      label: 'Contract deployed',
      text: contractInitialMessage || 'Initial message stored',
      author: contractConfig.deployer,
    }
  }

  if (
    !transaction.to ||
    transaction.to.toLowerCase() !== contractConfig.address.toLowerCase() ||
    !transaction.input ||
    transaction.input === '0x'
  ) {
    return null
  }

  try {
    const decoded = decodeFunctionData({
      abi: contractConfig.abi,
      data: transaction.input,
    })
    if (decoded.functionName !== 'store') return null
    return {
      label: 'Message stored',
      text: decoded.args[0],
      author: transaction.from,
    }
  } catch {
    return null
  }
}

async function getBalanceAtBlock(address, blockNumber) {
  if (!address) return null
  const cacheKey = `${blockNumber}:${address.toLowerCase()}`
  if (!balanceCache.has(cacheKey)) {
    balanceCache.set(
      cacheKey,
      publicClient.getBalance({ address, blockNumber }).catch(() => null)
    )
  }
  return balanceCache.get(cacheKey)
}

async function createBlockViewModel(block) {
  const transactions = await Promise.all(
    block.transactions.map(async (transaction) => {
      if (typeof transaction === 'string') {
        return {
          hash: transaction,
          from: null,
          to: null,
          value: 0n,
          fromBalance: null,
          toBalance: null,
          detailsAvailable: false,
        }
      }

      const [fromBalance, toBalance] = await Promise.all([
        getBalanceAtBlock(transaction.from, block.number),
        getBalanceAtBlock(transaction.to, block.number),
      ])

      return {
        hash: transaction.hash,
        from: transaction.from,
        to: transaction.to,
        value: transaction.value ?? 0n,
        fromBalance,
        toBalance,
        contractActivity: getContractActivity(transaction),
        detailsAvailable: true,
      }
    })
  )

  return {
    number: block.number,
    hash: block.hash,
    parentHash: block.parentHash,
    transactions,
  }
}

function renderWalletRow(label, address, balance, fallback = 'Unavailable') {
  const addressLabel = address ? shortenHex(address, 8, 6) : fallback
  const addressTitle = address ? ` title="${address}"` : ''
  return `
    <div class="wallet-row">
      <div class="wallet-identity">
        <span>${label}</span>
        <code${addressTitle}>${addressLabel}</code>
      </div>
      <div class="wallet-balance">
        <span>Balance after block</span>
        <strong>${address ? formatBalance(balance) : '—'}</strong>
      </div>
    </div>
  `
}

function renderTransaction(transaction, index) {
  if (!transaction.detailsAvailable) {
    return `
      <li class="transaction-item transaction-unavailable">
        <div class="transaction-heading">
          <span>TX ${index + 1}</span>
          <strong>Details unavailable</strong>
        </div>
        <code title="${transaction.hash}">${shortenHex(transaction.hash, 10, 8)}</code>
      </li>
    `
  }

  const contractActivity = transaction.contractActivity
    ? `
      <div class="contract-activity">
        <span class="contract-activity-label">${escapeHtml(transaction.contractActivity.label)}</span>
        <p>${escapeHtml(transaction.contractActivity.text)}</p>
        <code title="${transaction.contractActivity.author}">
          Author: ${shortenHex(transaction.contractActivity.author, 10, 8)}
        </code>
      </div>
    `
    : ''

  return `
    <li class="transaction-item">
      <div class="transaction-heading">
        <span>TX ${index + 1}</span>
        <strong>${formatEthValue(transaction.value)} ETH</strong>
      </div>
      <code class="transaction-hash" title="${transaction.hash}">${shortenHex(transaction.hash, 10, 8)}</code>
      <div class="wallet-flow">
        ${renderWalletRow('From', transaction.from, transaction.fromBalance)}
        <span class="transfer-direction" aria-hidden="true">↓</span>
        ${renderWalletRow('To', transaction.to, transaction.toBalance, 'Contract creation')}
      </div>
      ${contractActivity}
    </li>
  `
}

function renderBlock(block, isNew = false) {
  const transactionCount = block.transactions.length
  const emptyDetail = block.number === 0n ? 'Genesis state only' : 'No transfers recorded'
  const transactionsHtml = transactionCount
    ? `<ol class="transaction-list">${block.transactions.map(renderTransaction).join('')}</ol>`
    : `
      <div class="empty-block">
        <span aria-hidden="true">◆</span>
        <strong>No transactions</strong>
        <small>${emptyDetail}</small>
      </div>
    `

  const previousLabel = block.number === 0n
    ? 'Genesis'
    : shortenHex(block.parentHash, 8, 6)

  return `
    <article
      class="block-card${block.number === 0n ? ' genesis-block' : ''}${isNew ? ' is-new' : ''}"
      role="listitem"
      data-block-number="${block.number}"
      aria-label="Block ${block.number}, ${transactionCount} transaction${transactionCount === 1 ? '' : 's'}"
    >
      <div class="block-header">
        <div>
          <span class="block-label">Block</span>
          <span class="block-number">#${block.number}</span>
        </div>
        <span class="tx-count">${transactionCount} tx${transactionCount === 1 ? '' : 's'}</span>
      </div>
      <dl class="block-meta">
        <div>
          <dt>Hash</dt>
          <dd><code title="${block.hash}">${shortenHex(block.hash, 8, 6)}</code></dd>
        </div>
        <div>
          <dt>Previous</dt>
          <dd><code title="${block.parentHash}">${previousLabel}</code></dd>
        </div>
      </dl>
      <div class="block-transactions">${transactionsHtml}</div>
    </article>
  `
}

function renderChainLink() {
  return '<div class="chain-link" aria-hidden="true"></div>'
}

function setExplorerState(message, variant = '') {
  $('blocks-container').innerHTML = `<div class="explorer-state ${variant}">${message}</div>`
}

function announceExplorer(message) {
  $('explorer-live-status').textContent = message
}

function setExplorerConnection(isConnected) {
  $('explorer-connection').classList.toggle('offline', !isConnected)
  $('explorer-connection-text').textContent = isConnected
    ? 'Auto-updating · 2s'
    : 'Waiting for RPC'
}

function isNearChainEnd(container) {
  return container.scrollWidth - container.scrollLeft - container.clientWidth < 96
}

function scrollToLatest(behavior = 'smooth') {
  const container = $('blocks-container')
  container.scrollTo({ left: container.scrollWidth, behavior })
}

async function fetchInitialBlocks() {
  const latestBlockNumber = await publicClient.getBlockNumber({ cacheTime: 0 })
  highestKnownBlock = latestBlockNumber
  const requests = []

  for (let number = 0n; number <= latestBlockNumber; number++) {
    requests.push(publicClient.getBlock({ blockNumber: number, includeTransactions: true }))
  }

  const blocks = await Promise.all(requests)
  const viewModels = await Promise.all(blocks.map(createBlockViewModel))
  const container = $('blocks-container')
  container.innerHTML = viewModels
    .map((block, index) => `${index > 0 ? renderChainLink() : ''}${renderBlock(block)}`)
    .join('')

  requestAnimationFrame(() => scrollToLatest('auto'))
  announceExplorer(
    `${viewModels.length} block${viewModels.length === 1 ? '' : 's'} loaded. Latest block is ${latestBlockNumber}.`
  )
}

async function pollNewBlocks() {
  try {
    const currentBlock = await publicClient.getBlockNumber({ cacheTime: 0 })
    if (currentBlock > highestKnownBlock) {
      const container = $('blocks-container')
      const shouldFollowLatest = isNearChainEnd(container)
      const newBlocksHtml = []

      for (let number = highestKnownBlock + 1n; number <= currentBlock; number++) {
        const block = await publicClient.getBlock({
          blockNumber: number,
          includeTransactions: true,
        })
        const viewModel = await createBlockViewModel(block)
        newBlocksHtml.push(`${renderChainLink()}${renderBlock(viewModel, true)}`)
      }

      container.insertAdjacentHTML('beforeend', newBlocksHtml.join(''))
      highestKnownBlock = currentBlock
      if (shouldFollowLatest) requestAnimationFrame(() => scrollToLatest())

      announceExplorer(
        `New block${newBlocksHtml.length === 1 ? '' : 's'} added. Latest block is ${currentBlock}.`
      )
      $('latest-block').textContent = `#${currentBlock}`
      $('total-blocks').textContent = `${currentBlock + 1n}`
      $('rpc-status').textContent = 'Connected'
      $('rpc-status').className = 'connected'
      setExplorerConnection(true)

      if (contractAvailable) await readContractSummary()
    }
  } catch {
    $('rpc-status').textContent = 'Disconnected'
    $('rpc-status').className = 'disconnected'
    setExplorerConnection(false)
    announceExplorer('The blockchain connection was interrupted. Retrying automatically.')
  }
}

async function init() {
  $('login-btn').addEventListener('click', handleLogin)
  $('logout-btn').addEventListener('click', handleLogout)
  $('send-btn').addEventListener('click', handleSendTransaction)
  $('contract-refresh-btn').addEventListener('click', loadContractConfig)
  $('contract-write-btn').addEventListener('click', handleStoreMessage)
  $('contract-message').addEventListener('input', updateContractWriteState)

  $('private-key').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleLogin()
  })
  $('send-amount').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') handleSendTransaction()
  })

  updateContractWriteState()
  const connected = await initPublicClient()
  if (!connected) {
    setExplorerState('Waiting for Anvil. Start the local chain, then refresh this page.', 'error')
    showMissingContract('Anvil is not reachable. Start the local chain, then refresh this page.')
    setContractStatus('Waiting for RPC', 'error')
    return
  }

  try {
    await updateBlockchainStatus()
    await loadContractConfig()
    await fetchInitialBlocks()
  } catch {
    setExplorerState('Blocks could not be loaded. Check the Anvil terminal and refresh.', 'error')
    return
  }

  pollingTimer = setInterval(pollNewBlocks, POLL_INTERVAL)
}

init()
