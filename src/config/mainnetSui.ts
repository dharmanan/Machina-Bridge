// Mainnet reference supplied by the user from Circle's official Sui packages
// page, 2026-10-28. Documentation evidence is NOT live deployment verification.
export const SUI_MAINNET_V2_REFERENCE = Object.freeze({
  source: 'https://developers.circle.com/cctp/references/sui-packages',
  mtPackage: '0x16bcfcfc465f96281663a344641c017de84529370e11aa3879d0dce43ad6db87',
  tmmPackage: '0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830',
  handlerPackage: '0x185ed207c4d64fc594882ab927f9f3c6ff957aad03df8a731ba64378faeeb2bf',
  extensionsPackage: '0x194c593691aed72b23b967cacad967a93c0b17ff98180d417e91ac503ce3597d',
  mtState: '0x0c067f7d325e5b60e3179712e7783534ba1556cbb3d359d8161497e37689230c',
  tmmState: '0x06fb166941cd7bc095edc019d054a753ec3f1e4c25f28f2ecc4a6cfa0a9b1167',
  handlerState: '0xa32de8a6dd0178fb05f662929d55cddb69a25c26bde4b83f89e36d17ead94c41',
  treasury: '0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7',
  // Never substitute callable package IDs or the Arc remote identifier here.
  mtOriginalPackage: null,
  tmmOriginalPackage: null,
  inboundAuthRecipient: null,
} as const)
