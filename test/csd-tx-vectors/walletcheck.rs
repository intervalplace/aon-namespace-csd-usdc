// Verifies wallet-built transactions with CSD's own consensus code.
// stdin: JSON array of {tx: <node /tx/submit Transaction>, addrs: [hex addr20 per input]}
// stdout: JSON array of {txid, ok, err}
use csd::crypto::{txid, verify_sig, hash160};
use csd::types::Transaction;
use csd::codec::consensus_bincode;
use bincode::Options;
use std::io::Read;

fn hx(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }

fn main() {
    let mut s = String::new(); std::io::stdin().read_to_string(&mut s).unwrap();
    let items: Vec<serde_json::Value> = serde_json::from_str(&s).unwrap();
    let mut out = vec![];
    for it in items {
        let tx: Transaction = serde_json::from_value(it["tx"].clone()).unwrap();
        let addrs: Vec<String> = serde_json::from_value(it["addrs"].clone()).unwrap();
        let raw = consensus_bincode().serialize(&tx).unwrap();
        let mut err = String::new();
        for (k, inp) in tx.inputs.iter().enumerate() {
            let sig = &inp.script_sig;
            if sig.len() != 99 || sig[0] != 64 || sig[65] != 33 { err = format!("input {k}: bad scriptsig"); break; }
            let mut s64 = [0u8; 64]; s64.copy_from_slice(&sig[1..65]);
            if let Err(e) = verify_sig(&tx, &s64, &sig[66..99]) { err = format!("input {k}: {e}"); break; }
            if hx(&hash160(&sig[66..99])) != addrs[k] { err = format!("input {k}: pubkey/address mismatch"); break; }
        }
        out.push(serde_json::json!({ "txid": hx(&txid(&tx)), "raw": hx(&raw), "ok": err.is_empty(), "err": err }));
    }
    println!("{}", serde_json::to_string(&out).unwrap());
}
