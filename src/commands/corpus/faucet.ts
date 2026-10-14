import { type CommandIO, CommandError, InputFieldType, type InputSchema, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, formatUnits, parseAbi } from "viem";
import { CHAINS, CorpusCommand, erc20Abi, toUnits } from "../../corpus.js";

const inputs = {
  amount: { type: InputFieldType.Text, flag: "amount", message: "Mock USDC to mint (default 1000, max 5000)", required: false, prompt: false, index: 0 },
} satisfies InputSchema;
type FaucetResult = { chainId: number; usdc: string; account: string; mintedUsdc: string; balanceUsdc: string; tx: string };
const mockAbi = parseAbi(["function mint(address to, uint256 amount)"]);

export default class CorpusFaucet extends CorpusCommand<FaucetResult> {
  static override description = "Mint testnet mock USDC to the active account (Monad testnet only), so it can mint compute and trade on the Kuru testnet market. Needs a little testnet MON for gas (faucet.monad.xyz).";
  static override examples = ["<%= config.bin %> corpus faucet 1000 --json"];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "corpus:faucet";
  async execute(io: CommandIO): Promise<FaucetResult> {
    const { amount } = await io.resolveInputs(inputs);
    const chain = CHAINS[10143]; const c = this.client(chain);
    const n = Number(amount || "1000");
    if (!(n > 0) || n > 5000) throw new CommandError("INVALID_INPUT", "amount must be between 0 and 5000 mock USDC.", "Example: mm corpus faucet 1000");
    const me = await this.activeAddress(); const units = toUnits(String(amount || "1000"), 10n ** 6n);
    io.emit(`Minting ${n} mock USDC on ${chain.name} to ${me}…`);
    const tx = await this.sendTx(io, chain, chain.usdc, encodeFunctionData({ abi: mockAbi, functionName: "mint", args: [me, units] }));
    const bal = await c.readContract({ address: chain.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me] });
    return { chainId: chain.chainId, usdc: chain.usdc, account: me, mintedUsdc: formatUnits(units, 6), balanceUsdc: formatUnits(bal, 6), tx };
  }
  override successHint(r: FaucetResult): string { return `Minted ${r.mintedUsdc} mock USDC; the account holds ${r.balanceUsdc} on Monad Testnet. Tx ${r.tx}`; }
}
