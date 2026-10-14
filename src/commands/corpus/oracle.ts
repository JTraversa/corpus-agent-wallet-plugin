import { type CommandIO, InputFieldType, type InputSchema, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { CorpusCommand, DEPLOYMENTS, oracleAbi, requireAddress, resolveChain } from "../../corpus.js";

const inputs = {
  ticker: { type: InputFieldType.Text, flag: "ticker", message: "Index ticker", required: false, prompt: false, index: 0 },
  oracle: { type: InputFieldType.Text, flag: "oracle", message: "FixingOracle address", required: false, prompt: false },
  chainId: { type: InputFieldType.Text, flag: "chain-id", message: "Monad chain id (10143 testnet, where the contracts live; 143 mainnet)", required: false, prompt: false },
} satisfies InputSchema;
type OracleResult = { chainId: number; oracle: string; ticker: string; day: string; valueUsd: number; valueE18: string; n: number; postedAt: number; methodology: string; publisher: string };

export default class CorpusOracle extends CorpusCommand<OracleResult> {
  static override description = "Read the latest publisher-signed compute price fixing from FixingOracle on Monad (free, no payment).";
  static override examples = ["<%= config.bin %> corpus oracle CX.H100SXM.NEO --json"];
  static override requiresAuth = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "corpus:oracle";
  async execute(io: CommandIO): Promise<OracleResult> {
    const { ticker, oracle, chainId } = await io.resolveInputs(inputs);
    const chain = resolveChain(chainId || 10143); const addr = requireAddress(oracle, "oracle", DEPLOYMENTS[chain.chainId]?.oracle);
    const t = ticker || "CX.H100SXM.NEO"; const c = this.client(chain);
    const [f, publisher] = await Promise.all([c.readContract({ address: addr, abi: oracleAbi, functionName: "latest", args: [t] }), c.readContract({ address: addr, abi: oracleAbi, functionName: "publisher" })]);
    return { chainId: chain.chainId, oracle: addr, ticker: t, day: f.day, valueUsd: Number(f.valueE18) / 1e18, valueE18: f.valueE18.toString(), n: f.n, postedAt: Number(f.postedAt), methodology: f.methodology, publisher };
  }
  override successHint(r: OracleResult): string { return `${r.ticker} ${r.day}: $${r.valueUsd.toFixed(2)} per GPU-hour (n=${r.n}).`; }
}
