
use num_bigint::BigUint;
use num_traits::{One, ToPrimitive, Zero};
use anyhow_lite::*;
mod anyhow_lite { pub type Result<T> = std::result::Result<T, String>; #[macro_export] macro_rules! bail { ($($t:tt)*) => { return Err(format!($($t)*)) } } }

const LWMA_WINDOW: usize = 45;
const TARGET_BLOCK_SECS: u64 = 120;
const LWMA_SOLVETIME_MAX_FACTOR: u64 = 12;
static mut POW_LIMIT: u32 = 0x1e00ffff;

fn bits_parts(bits: u32) -> (u32, u32) {
    let exp = (bits >> 24) & 0xff;
    let mant = bits & 0x00ff_ffff;
    (exp, mant)
}

/// Compact bits -> 32-byte BE target.
/// Returns [0;32] on invalid encoding.
pub fn bits_to_target_bytes(bits: u32) -> [u8; 32] {
    let (exp_u32, mant) = bits_parts(bits);
    let exp = exp_u32 as usize;

    if exp == 0 || mant == 0 {
        return [0u8; 32];
    }
    if (mant & 0x0080_0000) != 0 {
        return [0u8; 32];
    }
    if exp > 32 {
        return [0u8; 32];
    }

    let mant_u = BigUint::from(mant as u64);

    let target = if exp_u32 <= 3 {
        let shift = 8u32 * (3u32 - exp_u32);
        mant_u >> shift
    } else {
        let shift = 8u32 * (exp_u32 - 3u32);
        mant_u << shift
    };

    if target.is_zero() || target.bits() > 256 {
        return [0u8; 32];
    }

    biguint_to_target_bytes(&target)
}

/// 32-byte BE target -> compact bits (canonical). Returns 0 for zero target.
pub fn target_bytes_to_bits(target: [u8; 32]) -> u32 {
    let x = BigUint::from_bytes_be(&target);
    if x.is_zero() {
        return 0;
    }

    let bytes = x.to_bytes_be();
    let mut exp = bytes.len() as u32;

    let mut mant: u32 = if exp <= 3 {
        let shift = 8u32 * (3u32 - exp);
        let m = (&x << shift).to_u64().unwrap_or(u64::MAX);
        (m as u32) & 0x00ff_ffff
    } else {
        ((bytes[0] as u32) << 16) | ((bytes[1] as u32) << 8) | (bytes[2] as u32)
    };

    if (mant & 0x0080_0000) != 0 {
        mant >>= 8;
        exp += 1;
    }

    mant &= 0x00ff_ffff;
    (exp << 24) | mant
}

fn biguint_to_target_bytes(x: &BigUint) -> [u8; 32] {
    let mut out = [0u8; 32];
    let bytes = x.to_bytes_be();
    if bytes.is_empty() {
        return out;
    }
    let slice = if bytes.len() > 32 {
        &bytes[bytes.len() - 32..]
    } else {
        &bytes[..]
    };
    let start = 32 - slice.len();
    out[start..].copy_from_slice(slice);
    out
}


// bits_within_pow_limit, verbatim except POW_LIMIT_BITS is a test parameter
pub fn bits_within_pow_limit(bits: u32) -> bool {
    if bits == 0 {
        return false;
    }
    let t = bits_to_target_bytes(bits);
    if t == [0u8; 32] {
        return false;
    }
    let limit = bits_to_target_bytes(unsafe { POW_LIMIT });
    if limit == [0u8; 32] {
        return false;
    }
    t <= limit
}

// work_from_bits, verbatim
pub fn work_from_bits(bits: u32) -> Result<u128> {
    if !bits_within_pow_limit(bits) {
        bail!("bits beyond pow limit (or zero/invalid)");
    }
    let t_bytes = bits_to_target_bytes(bits);
    let target = BigUint::from_bytes_be(&t_bytes);
    if target.is_zero() {
        bail!("invalid target (zero)");
    }
    let two_256: BigUint = BigUint::one() << 256;
    let denom = &target + BigUint::one();
    let w = two_256 / denom;
    let max = BigUint::from(u128::MAX);
    let w = if w > max { max } else { w };
    Ok(w.to_u128().unwrap_or(u128::MAX))
}

// expected_bits_strict with the DB walk replaced by a slice of (time, bits)
// for the headers ending at the parent, newest first (what the walk collects).
fn expected_bits(height: u64, parent_bits: u32, walk: &[(u64, u32)]) -> Result<u32> {
    #[allow(non_snake_case)]
    let POW_LIMIT_BITS = unsafe { POW_LIMIT };
    if !bits_within_pow_limit(parent_bits) {
        bail!("expected_bits: parent.bits invalid/beyond pow limit");
    }
    if height < 2 {
        return Ok(parent_bits);
    }
    let mut n = LWMA_WINDOW.min(height as usize);
    if n < 2 {
        return Ok(parent_bits);
    }
    if n > 1000 {
        n = 1000;
    }
    let mut times: Vec<u64> = Vec::with_capacity(n);
    let mut targets: Vec<BigUint> = Vec::with_capacity(n);
    for &(time, bits) in walk.iter().take(n) {
        let tb = bits_to_target_bytes(bits);
        if tb == [0u8; 32] {
            bail!("expected_bits: invalid compact bits in history window");
        }
        times.push(time);
        targets.push(BigUint::from_bytes_be(&tb));
    }
    if times.len() < 2 {
        return Ok(parent_bits);
    }
    #[allow(unused_variables)]
    let parent = Parent { bits: parent_bits };
    times.reverse();
    targets.reverse();

    let m = times.len();
    if m < 2 {
        return Ok(parent.bits);
    }

    let t = TARGET_BLOCK_SECS.max(1);
    let max_solvetime = (LWMA_SOLVETIME_MAX_FACTOR.max(1)).saturating_mul(t);

    let mut weighted_sum: u128 = 0;
    let mut denom: u128 = 0;

    for i in 1..m {
        let dt = times[i].saturating_sub(times[i - 1]);
        let st = dt.clamp(1, max_solvetime);
        let w = i as u128;
        weighted_sum = weighted_sum.saturating_add((st as u128).saturating_mul(w));
        denom = denom.saturating_add(w);
    }

    if denom == 0 {
        return Ok(parent.bits);
    }

    let avg_solvetime = (weighted_sum / denom) as u64;

    let mut sum_target = BigUint::zero();
    for tg in &targets {
        sum_target += tg;
    }
    let avg_target = sum_target / BigUint::from(m as u64);

    let mut next_target = avg_target * BigUint::from(avg_solvetime) / BigUint::from(t);

    let limit_tb = bits_to_target_bytes(POW_LIMIT_BITS);
    if limit_tb == [0u8; 32] {
        bail!("POW_LIMIT_BITS invalid (params)");
    }
    let limit = BigUint::from_bytes_be(&limit_tb);
    if next_target > limit {
        next_target = limit;
    }
    if next_target.is_zero() || next_target.bits() > 256 {
        return Ok(POW_LIMIT_BITS);
    }

    let tb = biguint_to_target_bytes(&next_target);
    let bits = target_bytes_to_bits(tb);

    if !bits_within_pow_limit(bits) {
        return Ok(POW_LIMIT_BITS);
    }

    Ok(bits)
}

struct Parent { bits: u32 }

// median_time_past over the newest-first times
fn mtp(walk: &[(u64, u32)]) -> u64 {
    let mut t: Vec<u64> = walk.iter().take(11).map(|x| x.0).collect();
    t.sort_unstable();
    t[t.len() / 2]
}

struct Rng(u64);
impl Rng { fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 } fn below(&mut self, n: u64) -> u64 { self.next() % n } }

fn main() {
    let mut rng = Rng(0x9e3779b97f4a7c15);
    let mut out = String::from("[");
    let limits = [0x1e00ffffu32, 0x207fffffu32];
    let mut first = true;
    for case in 0..3000u32 {
        let limit = limits[(case % 2) as usize];
        unsafe { POW_LIMIT = limit; }
        // a plausible history: start near some difficulty, random solvetimes
        let len = if case % 7 == 0 { 2 + rng.below(44) as usize } else { 45 };
        let height = if len < 45 { len as u64 } else { 45 + rng.below(1_000_000) };
        let limit_t = BigUint::from_bytes_be(&bits_to_target_bytes(limit));
        let mut target = &limit_t >> (rng.below(40) as usize);
        let mut t: u64 = 1_700_000_000 + rng.below(10_000_000);
        let mut walk_old_first: Vec<(u64, u32)> = Vec::new();
        for _ in 0..len {
            let mode = rng.below(10);
            let dt: i64 = match mode { 0 => 0, 1 => -(rng.below(300) as i64), 2 => 3000 + rng.below(20000) as i64, 3 => 1, _ => rng.below(400) as i64 };
            t = if dt < 0 { t.saturating_sub((-dt) as u64) } else { t + dt as u64 };
            // drift target a little each block
            let f = 900 + rng.below(200);
            target = (&target * BigUint::from(f)) / BigUint::from(1000u32);
            if target > limit_t { target = limit_t.clone(); }
            if target.is_zero() { target = BigUint::one(); }
            let bits = target_bytes_to_bits(biguint_to_target_bytes(&target));
            let bits = if bits_within_pow_limit(bits) { bits } else { limit };
            walk_old_first.push((t, bits));
        }
        let walk: Vec<(u64, u32)> = walk_old_first.iter().rev().cloned().collect();
        let parent_bits = walk[0].1;
        let want = match expected_bits(height, parent_bits, &walk) { Ok(b) => b, Err(_) => continue };
        let work = work_from_bits(parent_bits).unwrap_or(0);
        if !first { out.push(','); } first = false;
        out.push_str(&format!(
            "{{\"limit\":{},\"height\":{},\"parentBits\":{},\"times\":[{}],\"bits\":[{}],\"want\":{},\"mtp\":{},\"parentWork\":\"{}\"}}",
            limit, height, parent_bits,
            walk.iter().map(|x| x.0.to_string()).collect::<Vec<_>>().join(","),
            walk.iter().map(|x| x.1.to_string()).collect::<Vec<_>>().join(","),
            want, mtp(&walk), work));
    }
    out.push(']');
    println!("{}", out);
}
