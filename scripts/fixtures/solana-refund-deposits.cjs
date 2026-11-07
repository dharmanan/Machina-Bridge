// Generated Solana -> Arc CCTP deposits for regression tests: fresh keys, random signatures and nonces,
// caller-chosen dates and rent. No real wallet, signature, event account or nonce is used here.
// Shapes follow the Solana JSON-RPC answers (getTransaction jsonParsed, getMultipleAccounts base64)
// and Circle Iris /v2/messages, as observed on Mainnet.
// The caller must install the .ts require hook first (cctp-recovery.cjs loads TypeScript sources).
const crypto = require('node:crypto')
const { Keypair, PublicKey } = require('@solana/web3.js')
const bs58mod = require('bs58'), bs58 = bs58mod.default || bs58mod
const { word, message, zero, source, sc } = require('./cctp-recovery.cjs')

const solWord = (key) => '0x' + new PublicKey(key).toBuffer().toString('hex')
const randomKey = () => Keypair.generate().publicKey.toBase58()
const randomSignature = () => bs58.encode(crypto.randomBytes(64))
const randomEvm = () => '0x' + crypto.randomBytes(20).toString('hex')

function accountData({ rentPayer, createdAtSec, onChainMessage }) {
  const data = Buffer.alloc(428)
  Buffer.from('83648538a6e1973c', 'hex').copy(data)
  new PublicKey(rentPayer).toBuffer().copy(data, 8)
  data.writeBigInt64LE(BigInt(createdAtSec), 40)
  data.writeUInt32LE(376, 48)
  Buffer.from(onChainMessage.slice(2), 'hex').copy(data, 52)
  return data
}

// One deposit as the chain and Circle would report it. Every part can be tampered with by the test.
function makeDeposit({ wallet = randomKey(), evm = randomEvm(), createdAtSec, lamports = 3_900_000, amount = 100_000 } = {}) {
  const eventAccount = randomKey(), signature = randomSignature(), wrapperProgram = randomKey()
  const nonce = '0x' + crypto.randomBytes(32).toString('hex')
  const fields = {
    src: 5, dst: 26, sender: solWord(sc.tokenMessengerMinterProgram), recipient: word(source.tokenMessengerAddress),
    caller: zero, min: 1000, burn: solWord(sc.usdcMint), mint: word(evm), amount, from: solWord(wallet), max: 3,
  }
  const onChainMessage = message(fields)
  const attestedMessage = message({ ...fields, nonce, executed: 1000, fee: 2, expires: 29_000_000 })
  const tx = {
    slot: 400_000_000 + Math.floor(Math.random() * 1e6),
    blockTime: createdAtSec,
    version: 0,
    meta: {
      err: null,
      innerInstructions: [{
        index: 2,
        instructions: [
          { programId: sc.tokenMessengerMinterProgram, accounts: [wallet, eventAccount], data: '1', stackHeight: 2 },
          { programId: sc.messageTransmitterProgram, accounts: [wallet, eventAccount, sc.tokenMessengerMinterProgram], data: '1', stackHeight: 3 },
        ],
      }],
      logMessages: [],
    },
    transaction: {
      signatures: [signature, randomSignature()],
      message: {
        accountKeys: [
          { pubkey: wallet, signer: true, writable: true, source: 'transaction' },
          { pubkey: eventAccount, signer: true, writable: true, source: 'transaction' },
          { pubkey: wrapperProgram, signer: false, writable: false, source: 'transaction' },
          { pubkey: sc.tokenMessengerMinterProgram, signer: false, writable: false, source: 'transaction' },
          { pubkey: sc.messageTransmitterProgram, signer: false, writable: false, source: 'transaction' },
        ],
        instructions: [{ programId: wrapperProgram, accounts: [wallet, eventAccount], data: '1', stackHeight: null }],
        recentBlockhash: randomKey(),
      },
    },
  }
  const accountInfo = {
    data: [accountData({ rentPayer: wallet, createdAtSec, onChainMessage }).toString('base64'), 'base64'],
    executable: false, lamports, owner: sc.messageTransmitterProgram, rentEpoch: 18446744073709551615, space: 428,
  }
  const iris = { messages: [{ status: 'complete', message: attestedMessage, attestation: '0x' + 'ab'.repeat(130), eventNonce: nonce }] }
  return { wallet, evm, eventAccount, signature, nonce, createdAtSec, lamports, amount, onChainMessage, attestedMessage, tx, accountInfo, iris, accountData }
}

module.exports = { makeDeposit, randomKey, randomSignature, randomEvm, accountData, solWord }
