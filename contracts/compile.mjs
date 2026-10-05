// Compile contracts/src/*.sol with the official solc-js compiler and write ABI + bytecode.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, "src");
const outDir = path.join(here, "out");
const sources = {};
for (const f of fs.readdirSync(srcDir).filter((f) => f.endsWith(".sol"))) {
  sources[f] = { content: fs.readFileSync(path.join(srcDir, f), "utf8") };
}
const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter((e) => e.severity === "error");
for (const e of output.errors || []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);
fs.mkdirSync(outDir, { recursive: true });
for (const [file, contracts] of Object.entries(output.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    const artifact = { contractName: name, sourceName: file, compiler: solc.version(), abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
    fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(artifact, null, 1));
    const webDir = path.join(here, "..", "web", "public", "contract");
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(path.join(webDir, `${name}.json`), JSON.stringify(artifact, null, 1));
    console.log(`${name}: ${c.evm.bytecode.object.length / 2} bytes, ${c.abi.length} ABI entries`);
  }
}
