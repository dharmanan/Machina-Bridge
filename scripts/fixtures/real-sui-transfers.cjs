// Stored-record form of the five real transfers (what this browser's Sui
// history holds after they completed). Used by Node and browser fixtures.
const REAL_SUI_TRANSFERS = require('./real-sui-transfers.json')
function realSuiRecords() {
  return REAL_SUI_TRANSFERS.transfers.map(t => {
    const sourceId = t.direction === 'arc-to-sui' ? t.source.toLowerCase() : t.source
    return { direction: t.direction, sourceId, suiOwner: REAL_SUI_TRANSFERS.sui, evmOwner: REAL_SUI_TRANSFERS.evm, amount: '0.1', maxFeeUnits: '0', sourceEventIndex: t.eventIndex, stage: 'complete', destinationTx: t.destination, feeUsdc: '0', receivedUsdc: '0.1', checkedAt: Date.parse(t.destinationTime), createdAt: Date.parse(t.sourceTime), sourceTime: Date.parse(t.sourceTime), id: `${t.direction}:${sourceId}:${t.eventIndex}` }
  })
}
module.exports = { REAL_SUI_TRANSFERS, realSuiRecords }
