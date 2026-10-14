import { type CommandIO, InputFieldType, type InputSchema, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { formatUnits } from "viem";
import { CorpusCommand, KURU, kuruBook, kuruMarket, requireAddress, resolveChain, tokenAbi, wrapperAbi, type Level } from "../../corpus.js";

const inputs = {
  market: { type: InputFieldType.Text, flag: "market", message: "Kuru OrderBook address", required: false, prompt: false },
  depth: { type: InputFieldType.Text, flag: "depth", message: "Levels per side (default 5)", required: false, prompt: false },
  chainId: { type: InputFieldType.Text, flag: "chain-id", message: "Monad chain id (10143 testnet, where the market lives; 143 mainnet)", required: false, prompt: false },
} satisfies InputSchema;
type BookResult = {
  chainId: number; market: string; pair: string; block: number; bestBid: number | null; bestAsk: number | null; spread: number | null;
  mintPriceUsdc: number; askVsMintPct: number | null; takerFeeBps: number; makerFeeBps: number; minSize: number; bids: Level[]; asks: Level[];
};

export default class CorpusBook extends CorpusCommand<BookResult> {
  static override description = "Read the Kuru order book for tokenized corpus compute (cS1-256/USDC): bids, asks, spread, and where the best ask sits against the mint price.";
  static override examples = ["<%= config.bin %> corpus book --json", "<%= config.bin %> corpus book --depth 10 --json"];
  static override requiresAuth = false;
  static override flags = schemaToFlags(inputs);
  protected readonly pluginCommandId = "corpus:book";
  async execute(io: CommandIO): Promise<BookResult> {
    const { market, depth, chainId } = await io.resolveInputs(inputs);
    const chain = resolveChain(chainId || 10143); const c = this.client(chain);
    const m = await kuruMarket(c, requireAddress(market, "market", KURU[chain.chainId]?.market));
    const [book, symbol, token, id] = await Promise.all([
      kuruBook(c, m),
      c.readContract({ address: m.base, abi: wrapperAbi, functionName: "symbol" }),
      c.readContract({ address: m.base, abi: wrapperAbi, functionName: "token" }),
      c.readContract({ address: m.base, abi: wrapperAbi, functionName: "id" })]);
    // The mint price is where new supply comes from, so it caps what a rational buyer pays on the book.
    const size = await c.readContract({ address: token, abi: tokenAbi, functionName: "types", args: [id] });
    const mint = Number(formatUnits(size[4], 6)); const n = Number(depth || "5");
    const bestBid = book.bids[0]?.price ?? null; const bestAsk = book.asks[0]?.price ?? null;
    return {
      chainId: chain.chainId, market: m.address, pair: `${symbol}/USDC`, block: book.block, bestBid, bestAsk,
      spread: bestBid !== null && bestAsk !== null ? +(bestAsk - bestBid).toFixed(4) : null,
      mintPriceUsdc: mint, askVsMintPct: bestAsk !== null ? +(((bestAsk - mint) / mint) * 100).toFixed(2) : null,
      takerFeeBps: m.takerFeeBps, makerFeeBps: m.makerFeeBps, minSize: Number(m.minSize) / Number(m.sizePrecision),
      bids: book.bids.slice(0, n), asks: book.asks.slice(0, n),
    };
  }
  override successHint(r: BookResult): string {
    const side = (l: Level[]) => (l.length ? l.map((x) => `${x.size} @ $${x.price}`).join(", ") : "none");
    return `${r.pair} on Kuru (${r.market}): asks ${side(r.asks)}; bids ${side(r.bids)}. Mint price $${r.mintPriceUsdc}${r.askVsMintPct !== null ? `, best ask ${r.askVsMintPct}% vs mint` : ""}.`;
  }
}
