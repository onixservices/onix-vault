// Copy to web/config.js and fill in. web/config.js is gitignored.
//
// rpcUrl: an endpoint with DAS support. On the public site this is a same-origin proxy
// path (the key stays on the server); locally it can be your own endpoint.
// Everything else here is public by design — these are the addresses the page proves.
window.VAULTY_CONFIG = {
  rpcUrl: '/rpc',
  vaultWallet: '<VAULT_WALLET_ADDRESS>',
  // Leave null until the pool exists. The page then shows backing only, and says so.
  baseMint: null,
  pool: null,
  baseDecimals: 6,
  quoteDecimals: 6,
  feeBps: 1000,
  operator: 'Onix',
  vaultName: 'Vault #1',
};
