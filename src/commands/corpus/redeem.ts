import { type CommandIO, CommandError, InputFieldType, type InputSchema, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, keccak256, toHex } from "viem";
import { CorpusCommand, DEPLOYMENTS, requireAddress, resolveChain, tokenAbi } from "../../corpus.js";

const inputs = {
  id: { type: InputFieldType.Text, flag: "id", message: "Size id", required: true, index: 0 },
  account: { type: InputFieldType.Text, flag: "account", message: "corpus account id or email that receives the machine", required: true, index: 1 },
  qty: { type: InputFieldType.Text, flag: "qty", message: "How many machines", required: false, prompt: false, index: 2 },
  token: { type: InputFieldType.Text, flag: "token", message: "ComputeToken address", required: false, prompt: false },
  chainId: { type: InputFieldType.Text, flag: "chain-id", message: "Monad chain id (10143 testnet, where the contracts live; 143 mainnet)", required: false, prompt: false },
} satisfies InputSchema;
type RedeemResult = { chainId: number; token: string; id: number; label: string; qty: number; accountRef: string; tx: string };

export default class CorpusRedeem extends CorpusCommand<RedeemResult> {
  static override description = "Redeem compute tokens: burn them and name the corpus account that receives the permanently funded machine.";
  static override examples = ["<%= config.bin %> corpus redeem 2 me@example.com --json"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "corpus:redeem";
  async execute(io: CommandIO): Promise<RedeemResult> {
    const { id, account, qty, token, chainId } = await io.resolveInputs(inputs);
    const chain = resolveChain(chainId || 10143); const addr = requireAddress(token, "token", DEPLOYMENTS[chain.chainId]?.token); const c = this.client(chain);
    const sizeId = BigInt(id); const n = BigInt(qty || "1"); const me = await this.activeAddress();
    const [t, held] = await Promise.all([c.readContract({ address: addr, abi: tokenAbi, functionName: "types", args: [sizeId] }), c.readContract({ address: addr, abi: tokenAbi, functionName: "balanceOf", args: [me, sizeId] })]);
    if (held < n) throw new CommandError("INSUFFICIENT_TOKENS", `The account holds ${held} of ${t[1]}.`, "Mint first, or lower qty.");
    const ref = keccak256(toHex(String(account).trim()));
    io.emit(`Redeeming ${n} × ${t[1]} to corpus account reference ${ref.slice(0, 18)}…`);
    const tx = await this.sendTx(io, chain, addr, encodeFunctionData({ abi: tokenAbi, functionName: "redeem", args: [sizeId, n, ref] }));
    return { chainId: chain.chainId, token: addr, id: Number(sizeId), label: t[1], qty: Number(n), accountRef: ref, tx };
  }
  override successHint(r: RedeemResult): string { return `Redeemed ${r.qty} × ${r.label}; corpus opens the position from tx ${r.tx}.`; }
}
