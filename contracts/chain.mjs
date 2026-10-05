// In-memory EVM (ethereumjs, Cancun) shared by the tests and the browser demo.
import { Common, Hardfork, Mainnet } from "@ethereumjs/common";
import { createLegacyTx } from "@ethereumjs/tx";
import { Account, bytesToHex, createAddressFromPrivateKey, createAddressFromString, hexToBytes } from "@ethereumjs/util";
import { createVM, runTx } from "@ethereumjs/vm";
import { decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeDeployData, encodeFunctionData, keccak256, stringToHex } from "viem";

const NAMES = ["owner", "auditor", "verra", "goldstandard", "car", "acr", "outsider"];

export async function createChain() {
  const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
  const vm = await createVM({ common });
  const accounts = {};
  for (const name of NAMES) {
    const pk = hexToBytes(keccak256(stringToHex(`carbontwin-demo-${name}`)));
    const address = createAddressFromPrivateKey(pk);
    await vm.stateManager.putAccount(address, new Account(0n, 10n ** 24n));
    accounts[name] = { name, pk, address, hex: address.toString() };
  }

  async function nonceOf(address) {
    const acct = await vm.stateManager.getAccount(address);
    return acct ? acct.nonce : 0n;
  }

  async function execute(from, to, data) {
    const tx = createLegacyTx(
      { nonce: await nonceOf(from.address), gasPrice: 10_000_000_000n, gasLimit: 6_000_000n, to: to ?? undefined, data },
      { common },
    ).sign(from.pk);
    return runTx(vm, { tx, skipBlockGasLimitValidation: true });
  }

  async function deploy(artifact, from) {
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [] });
    const res = await execute(from, null, hexToBytes(data));
    if (res.execResult.exceptionError) throw new Error(`deploy failed: ${res.execResult.exceptionError.error}`);
    return contractHandle(artifact.abi, res.createdAddress.toString());
  }

  function contractHandle(abi, address) {
    const to = createAddressFromString(address);
    return {
      address,
      /** Send a transaction; resolves with { ok, gasUsed, events, error } and never throws on revert. */
      async send(from, functionName, args = []) {
        const data = encodeFunctionData({ abi, functionName, args });
        const res = await execute(from, to, hexToBytes(data));
        const ret = bytesToHex(res.execResult.returnValue);
        if (res.execResult.exceptionError) {
          let error = { name: res.execResult.exceptionError.error, args: [] };
          if (ret && ret !== "0x") {
            try {
              const dec = decodeErrorResult({ abi, data: ret });
              error = { name: dec.errorName, args: dec.args ?? [] };
            } catch { /* unknown revert data */ }
          }
          return { ok: false, gasUsed: res.totalGasSpent, events: [], error };
        }
        const events = [];
        for (const log of res.receipt.logs) {
          try {
            const topics = log[1].map((t) => bytesToHex(t));
            const dec = decodeEventLog({ abi, data: bytesToHex(log[2]), topics });
            events.push({ name: dec.eventName, args: dec.args });
          } catch { /* not ours */ }
        }
        return { ok: true, gasUsed: res.totalGasSpent, events, error: null };
      },
      /** Read-only call. */
      async call(functionName, args = [], from = accounts.outsider) {
        const data = encodeFunctionData({ abi, functionName, args });
        const res = await vm.evm.runCall({ to, caller: from.address, origin: from.address, data: hexToBytes(data), gasLimit: 6_000_000n });
        if (res.execResult.exceptionError) throw new Error(`call reverted: ${functionName}`);
        return decodeFunctionResult({ abi, functionName, data: bytesToHex(res.execResult.returnValue) });
      },
    };
  }

  return { vm, accounts, deploy };
}

/** keccak256 of a UTF-8 string, used for listing keys such as "VCS1931". */
export function key(text) {
  return keccak256(stringToHex(text));
}

/** bytes8 registry code, e.g. "VCS" -> 0x5643530000000000 */
export function code8(text) {
  const hex = stringToHex(text).slice(2).padEnd(16, "0").slice(0, 16);
  return `0x${hex}`;
}

/** Sorted-pair Merkle tree matching CreditClaimRegistry.verifyFinding. */
export function merkle(leaves) {
  const hashPair = (a, b) => (a < b ? keccak256(`${a}${b.slice(2)}`) : keccak256(`${b}${a.slice(2)}`));
  const layers = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
    layers.push(next);
  }
  const root = layers[layers.length - 1][0];
  const proof = (index) => {
    const out = [];
    for (let l = 0; l < layers.length - 1; l++) {
      const layer = layers[l];
      const sib = index ^ 1;
      if (sib < layer.length) out.push(layer[sib]);
      index >>= 1;
    }
    return out;
  };
  return { root, proof };
}
