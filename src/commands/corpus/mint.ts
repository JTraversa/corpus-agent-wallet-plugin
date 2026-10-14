import { type CommandIO, CommandError, InputFieldType, type InputSchema, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, formatUnits } from "viem";
import { CorpusCommand, DEPLOYMENTS, erc20Abi, requireAddress, resolveChain, tokenAbi } from "../../corpus.js";

const inputs = {
  id: { type: InputFieldType.Text, flag: "id", message: "Size id (see `mm corpus sizes`)", required: true, index: 0 },
  qty: { type: InputFieldType.Text, flag: "qty", message: "How many machines", required: false, prompt: false, index: 1 },
  token: { type: InputFieldType.Text, flag: "token", message: "ComputeToken address", required: false, prompt: false },
  chainId: { type: InputFieldType.Text, flag: "chain-id", message: "Monad chain id (10143 testnet, where the contracts live; 143 mainnet)", required: false, prompt: false },
} satisfies InputSchema;
type MintResult = { chainId: number; token: string; id: number; label: string; qty: number; paidUsdc: string; approveTx?: string; mintTx: string };

export default class CorpusMint extends CorpusCommand<MintResult> {
  static override description = "Mint permanently funded corpus compute: pay principal plus buffer in USDC once, receive a transferable ERC-1155 claim on the machine.";
  static override examples = ["<%= config.bin %> corpus mint 2 1 --json"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "corpus:mint";
  async execute(io: CommandIO): Promise<MintResult> {
    const { id, qty, token, chainId } = await io.resolveInputs(inputs);
    const chain = resolveChain(chainId || 10143); const addr = requireAddress(token, "token", DEPLOYMENTS[chain.chainId]?.token); const c = this.client(chain);
    const sizeId = BigInt(id); const n = BigInt(qty || "1"); if (n <= 0n) throw new CommandError("INVALID_INPUT", "qty must be at least 1.", "Pass a positive quantity.");
    const t = await c.readContract({ address: addr, abi: tokenAbi, functionName: "types", args: [sizeId] });
    if (!t[5]) throw new CommandError("INACTIVE", `${t[1]} is not open for minting.`, "Run `mm corpus sizes` for the active sizes.");
    const cost = t[4] * n; const usdc = await c.readContract({ address: addr, abi: tokenAbi, functionName: "usdc" });
    const me = await this.activeAddress();
    const bal = await c.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [me] });
    if (bal < cost) throw new CommandError("INSUFFICIENT_USDC", `Need ${formatUnits(cost, 6)} USDC on ${chain.name}; the account holds ${formatUnits(bal, 6)}.`, "Fund the account with USDC on Monad first.");
    io.emit(`Minting ${n} × ${t[1]} for ${formatUnits(cost, 6)} USDC (principal ${formatUnits(t[3] * n, 6)}, buffer ${formatUnits((t[4] - t[3]) * n, 6)}).`);
    let approveTx: `0x${string}` | undefined;
    const allowance = await c.readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [me, addr] });
    if (allowance < cost) approveTx = await this.sendTx(io, chain, usdc, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [addr, cost] }));
    const mintTx = await this.sendTx(io, chain, addr, encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [sizeId, n] }));
    return { chainId: chain.chainId, token: addr, id: Number(sizeId), label: t[1], qty: Number(n), paidUsdc: formatUnits(cost, 6), approveTx, mintTx };
  }
  override successHint(r: MintResult): string { return `Minted ${r.qty} × ${r.label} for ${r.paidUsdc} USDC. Tx ${r.mintTx}`; }
}
