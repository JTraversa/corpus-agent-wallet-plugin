import { type CommandIO, InputFieldType, type InputSchema, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { formatUnits } from "viem";
import { CorpusCommand, DEPLOYMENTS, requireAddress, resolveChain, tokenAbi } from "../../corpus.js";

const inputs = {
  token: { type: InputFieldType.Text, flag: "token", message: "ComputeToken address", required: false, prompt: false },
  chainId: { type: InputFieldType.Text, flag: "chain-id", message: "Monad chain id (10143 testnet, where the contracts live; 143 mainnet)", required: false, prompt: false },
} satisfies InputSchema;
type Size = { id: number; slug: string; label: string; monthlyUsdc: string; principalUsdc: string; priceUsdc: string; active: boolean; outstanding: string; held: string };
type SizesResult = { chainId: number; token: string; account?: string; sizes: Size[] };

export default class CorpusSizes extends CorpusCommand<SizesResult> {
  static override description = "List the compute sizes ComputeToken sells: monthly bill, principal, price once, outstanding supply, and what the active account holds.";
  static override examples = ["<%= config.bin %> corpus sizes --json"];
  static override flags = schemaToFlags(inputs);
  protected readonly pluginCommandId = "corpus:sizes";
  async execute(io: CommandIO): Promise<SizesResult> {
    const { token, chainId } = await io.resolveInputs(inputs);
    const chain = resolveChain(chainId || 10143); const addr = requireAddress(token, "token", DEPLOYMENTS[chain.chainId]?.token); const c = this.client(chain);
    let account: `0x${string}` | undefined; try { account = await this.activeAddress(); } catch { account = undefined; }
    const n = Number(await c.readContract({ address: addr, abi: tokenAbi, functionName: "typeCount" })); const sizes: Size[] = [];
    for (let id = 0; id < n; id++) {
      const [t, s, b] = await Promise.all([
        c.readContract({ address: addr, abi: tokenAbi, functionName: "types", args: [BigInt(id)] }),
        c.readContract({ address: addr, abi: tokenAbi, functionName: "totalSupply", args: [BigInt(id)] }),
        account ? c.readContract({ address: addr, abi: tokenAbi, functionName: "balanceOf", args: [account, BigInt(id)] }) : Promise.resolve(0n)]);
      sizes.push({ id, slug: t[0], label: t[1], monthlyUsdc: formatUnits(t[2], 6), principalUsdc: formatUnits(t[3], 6), priceUsdc: formatUnits(t[4], 6), active: t[5], outstanding: s.toString(), held: b.toString() });
    }
    return { chainId: chain.chainId, token: addr, account, sizes };
  }
  override successHint(r: SizesResult): string { return r.sizes.map((s) => `[${s.id}] ${s.label}: $${s.priceUsdc} once ($${s.monthlyUsdc}/mo), ${s.outstanding} outstanding${Number(s.held) ? `, you hold ${s.held}` : ""}`).join("\n"); }
}
