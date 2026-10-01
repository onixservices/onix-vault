/**
 * server/transfer.js — builds the transaction that moves ONE item out of the vault
 * wallet to a recipient, by token standard (DAS `interface`):
 *
 *   ProgrammableNFT → Token Metadata TransferV1 (token records for source and
 *     destination, plus the auth-rules program when the asset has a ruleSet). Plain
 *     SPL cannot move a pNFT: it is frozen by design.
 *   V1_NFT          → classic SPL transferChecked (destination ATA created first).
 *   MplCoreAsset    → Core transferV1 (no token accounts; the asset account IS the NFT;
 *     the collection goes along when the asset belongs to one).
 *   anything else   → UnsupportedStandardError. Nothing is guessed.
 *
 * The transaction comes back UNSIGNED, single-signer = fromAddress. The caller runs
 * `checkSingleSignerUnsigned` and only then signs. Ported from Onix.Cards' prize
 * delivery, which has run in production since August 2026.
 */
'use strict';
const { Transaction, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } = require('@solana/web3.js');
const {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const { createTransferInstruction: createTmTransferInstruction, PROGRAM_ID: TM_PROGRAM_ID, Metadata } = require('@metaplex-foundation/mpl-token-metadata');

const AUTH_RULES_PROGRAM_ID = new PublicKey('auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg');

class UnsupportedStandardError extends Error {
  constructor(iface) { super(`transfer: standard '${iface}' is not supported`); this.name = 'UnsupportedStandardError'; this.iface = iface; }
}

const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, TM_PROGRAM_ID)[0];
const metadataPda = (mint) => pda([Buffer.from('metadata'), TM_PROGRAM_ID.toBuffer(), mint.toBuffer()]);
const editionPda = (mint) => pda([Buffer.from('metadata'), TM_PROGRAM_ID.toBuffer(), mint.toBuffer(), Buffer.from('edition')]);
const tokenRecordPda = (mint, token) => pda([Buffer.from('metadata'), TM_PROGRAM_ID.toBuffer(), mint.toBuffer(), Buffer.from('token_record'), token.toBuffer()]);

let umi = null;
function getUmi() {
  if (!umi) { const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults'); umi = createUmi('http://localhost'); } // never called on the network: build only
  return umi;
}

function coreTransferIxs({ mint, fromAddress, toAddress, collection }) {
  const { transferV1 } = require('@metaplex-foundation/mpl-core');
  const { publicKey: umiPk, createNoopSigner } = require('@metaplex-foundation/umi');
  const { toWeb3JsInstruction } = require('@metaplex-foundation/umi-web3js-adapters');
  const signer = createNoopSigner(umiPk(fromAddress));
  const b = transferV1(getUmi(), { asset: umiPk(mint), newOwner: umiPk(toAddress), authority: signer, payer: signer, ...(collection && { collection: umiPk(collection) }) });
  return b.getInstructions().map(toWeb3JsInstruction);
}

/**
 * @param {{ getAssetMeta: (mint) => Promise<{interface, collection}>, getMetadataRuleSet: (mint) => Promise<string|null> }} deps
 */
function createTransferBuilder({ getAssetMeta, getMetadataRuleSet }) {
  async function buildTransferTx({ mint, fromAddress, toAddress, recentBlockhash }) {
    const meta = await getAssetMeta(mint);
    const iface = meta.interface;
    const mintPk = new PublicKey(mint);
    const fromPk = new PublicKey(fromAddress);
    const toPk = new PublicKey(toAddress);
    const tx = new Transaction({ feePayer: fromPk, recentBlockhash });

    if (iface === 'MplCoreAsset') {
      for (const ix of coreTransferIxs({ mint, fromAddress, toAddress, collection: meta.collection || null })) tx.add(ix);
      return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
    }
    const fromAta = getAssociatedTokenAddressSync(mintPk, fromPk);
    const toAta = getAssociatedTokenAddressSync(mintPk, toPk);
    if (iface === 'V1_NFT') {
      tx.add(createAssociatedTokenAccountIdempotentInstruction(fromPk, toAta, toPk, mintPk));
      tx.add(createTransferCheckedInstruction(fromAta, mintPk, toAta, fromPk, 1, 0));
    } else if (iface === 'ProgrammableNFT') {
      // TransferV1 creates the destination ATA and token record itself. Do NOT
      // prefix an SPL ATA-create: the duplicated writable account is the one thing
      // Phantom's preview rejects (measured 14 Jul 2026).
      const ruleSet = await getMetadataRuleSet(mint);
      tx.add(createTmTransferInstruction({
        token: fromAta, tokenOwner: fromPk, destination: toAta, destinationOwner: toPk, mint: mintPk,
        metadata: metadataPda(mintPk), edition: editionPda(mintPk),
        ownerTokenRecord: tokenRecordPda(mintPk, fromAta), destinationTokenRecord: tokenRecordPda(mintPk, toAta),
        authority: fromPk, payer: fromPk,
        systemProgram: SystemProgram.programId, sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        splTokenProgram: TOKEN_PROGRAM_ID, splAtaProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        ...(ruleSet && { authorizationRules: new PublicKey(ruleSet), authorizationRulesProgram: AUTH_RULES_PROGRAM_ID }),
      }, { transferArgs: { __kind: 'V1', amount: 1, authorizationData: null } }));
    } else {
      throw new UnsupportedStandardError(iface);
    }
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  }
  return { buildTransferTx };
}

// ── production deps: DAS for interface + collection; the metadata account for the ruleSet ──
function productionDeps(chain) {
  return {
    getAssetMeta: async (mint) => {
      const a = await chain.getAsset(mint);
      const col = (a?.grouping || []).find((g) => g.group_key === 'collection');
      return { interface: a?.interface || null, collection: col ? col.group_value : null };
    },
    getMetadataRuleSet: async (mint) => {
      const v = await chain.getAccountInfoBase64(metadataPda(new PublicKey(mint)).toBase58());
      if (!v) return null;
      const [meta] = Metadata.fromAccountInfo({ ...v, data: Buffer.from(v.data[0], 'base64') });
      return meta.programmableConfig?.ruleSet ? meta.programmableConfig.ruleSet.toBase58() : null;
    },
  };
}

module.exports = { createTransferBuilder, productionDeps, UnsupportedStandardError };
