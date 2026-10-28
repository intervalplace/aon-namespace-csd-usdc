// Test vectors for the EVM settlement: real CSD consensus encodings of
// payment transactions, their txids, a block's merkle root and header hash.
use csd::crypto::{txid, sha256d};
use csd::types::*;
use csd::codec::consensus_bincode;

fn hx(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }

fn main() {
    let c = consensus_bincode();
    let mk = |n: u8, outs: Vec<(u64, [u8; 20])>, app: AppPayload| Transaction {
        version: 1,
        inputs: vec![TxIn { prevout: OutPoint { txid: [n; 32], vout: n as u32 }, script_sig: vec![7u8; 99] }],
        outputs: outs.into_iter().map(|(value, s)| TxOut { value, script_pubkey: s }).collect(),
        locktime: 0,
        app,
    };
    let coinbase = Transaction { version: 1, inputs: vec![TxIn { prevout: OutPoint { txid: [0; 32], vout: u32::MAX }, script_sig: 77u64.to_le_bytes().to_vec() }],
        outputs: vec![TxOut { value: 50, script_pubkey: [9; 20] }], locktime: 77, app: AppPayload::None };
    let txs = vec![
        coinbase,
        mk(1, vec![(123_456_789, [0xab; 20]), (5, [0xcd; 20])], AppPayload::None),
        mk(2, vec![(42, [0x11; 20])], AppPayload::Attest { proposal_id: [3; 32], score: 7, confidence: 9 }),
        mk(3, vec![(1, [0x22; 20]), (2, [0x33; 20]), (3, [0x44; 20])], AppPayload::Propose { domain: "d".into(), payload_hash: [5; 32], uri: "u://x".into(), expires_epoch: 99 }),
    ];
    let ids: Vec<[u8; 32]> = txs.iter().map(txid).collect();
    // merkle root, as chain/mine.rs builds it
    let mut layer = ids.clone();
    while layer.len() > 1 {
        let mut next = vec![];
        let mut i = 0;
        while i < layer.len() { let l = layer[i]; let r = if i + 1 < layer.len() { layer[i + 1] } else { layer[i] }; let mut b = [0u8; 64]; b[..32].copy_from_slice(&l); b[32..].copy_from_slice(&r); next.push(sha256d(&b)); i += 2; }
        layer = next;
    }
    let header = BlockHeader { version: 1, prev: [0x42; 32], merkle: layer[0], time: 1_780_000_000, bits: 0x207fffff, nonce: 0 };
    let hh = csd::chain::index::header_hash(&header);
    print!("{{\"txs\":[");
    for (i, t) in txs.iter().enumerate() {
        if i > 0 { print!(","); }
        print!("{{\"raw\":\"0x{}\",\"txid\":\"0x{}\"}}", hx(&c.serialize(t).unwrap()), hx(&ids[i]));
    }
    println!("],\"merkle\":\"0x{}\",\"header\":{{\"version\":1,\"prev\":\"0x{}\",\"merkle\":\"0x{}\",\"time\":1780000000,\"bits\":{},\"nonce\":0}},\"headerHash\":\"0x{}\"}}",
        hx(&layer[0]), hx(&[0x42; 32]), hx(&layer[0]), 0x207fffffu32, hx(&hh));
}
