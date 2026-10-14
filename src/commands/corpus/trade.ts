import { type CommandIO, CommandError, InputFieldType, type InputSchema, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { encodeFunctionData, type Address, type Hex } from "viem";
import {
  CorpusCommand, KURU, erc1155ApprovalAbi, erc20Abi, kuruBook, kuruBookAbi, kuruMarginAbi, kuruMarket, requireAddress, resolveChain, toUnits, wrapperAbi, type Level,
} from "../../corpus.js";

const inputs = {
  side: { type: InputFieldType.Text, flag: "side", message: "buy or sell", required: true, index: 0 },
  size: { type: InputFieldType.Text, flag: "size", message: "Machines to trade (one unit is one machine; fractions down to the market's min size)", required: true, index: 1 },
  price: { type: InputFieldType.Text, flag: "price", message: "Limit price in USDC per machine; omit for a market order", required: false, prompt: false },
  slippage: { type: InputFieldType.Text, flag: "slippage", message: "Market orders: worst fill allowed vs the book, in percent (default 1)", required: false, prompt: false },
  maxSpend: { type: InputFieldType.Text, flag: "max-spend", message: "Buys: refuse if the order could cost more than this many USDC (default 50)", required: false, prompt: false },
  postOnly: { type: InputFieldType.Text, flag: "post-only", message: "Limit orders: rest on the book only, never take (true/false)", required: false, prompt: false },
  market: { type: InputFieldType.Text, flag: "market", message: "Kuru OrderBook address", required: false, prompt: false },
  chainId: { type: InputFieldType.Text, flag: "chain-id", message: "Monad chain id (10143 testnet, where the market lives; 143 mainnet)", required: false, prompt: false },
} satisfies InputSchema;
type TradeResult = {
  chainId: number; market: string; side: "buy" | "sell"; type: "market" | "limit"; size: number; price?: number; estAvgPrice?: number;
  notionalUsdc: number; txs: Record<string, string>;
};

/** Walk resting levels to fill `size`; returns the USDC notional, or null if the book is too thin. */
function walk(levels: Level[], size: number): number | null {
  let left = size, notional = 0;
  for (const l of levels) { const take = Math.min(left, l.size); notional += take * l.price; left -= take; if (left <= 1e-12) return notional; }
  return null;
}

export default class CorpusTrade extends CorpusCommand<TradeResult> {
  static override description = "Trade tokenized corpus compute on Kuru through the Agent Wallet: market orders against the book, or limit orders that rest on it. Wraps ComputeTokens into the ERC-20 the market lists when selling.";
  static override examples = [
    "<%= config.bin %> corpus trade buy 0.5 --max-spend 400 --json",
    "<%= config.bin %> corpus trade buy 1 --price 599.54 --post-only true --max-spend 700 --json",
    "<%= config.bin %> corpus trade sell 1 --price 640.46 --json",
  ];
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "corpus:trade";

  async execute(io: CommandIO): Promise<TradeResult> {
    const { side, size, price, slippage, maxSpend, postOnly, market, chainId } = await io.resolveInputs(inputs);
    const s = String(side).toLowerCase();
    if (s !== "buy" && s !== "sell") throw new CommandError("INVALID_INPUT", "side must be buy or sell.", "Example: mm corpus trade buy 0.5");
    const chain = resolveChain(chainId || 10143); const c = this.client(chain);
    const m = await kuruMarket(c, requireAddress(market, "market", KURU[chain.chainId]?.market));
    const qty = Number(size); const sizeUnits = toUnits(String(size), m.sizePrecision);
    if (!(qty > 0) || sizeUnits < m.minSize) throw new CommandError("BELOW_MIN_SIZE", `Size must be at least ${Number(m.minSize) / Number(m.sizePrecision)} machines.`, "Raise the size.");
    const slip = Number(slippage || "1") / 100; const cap = Number(maxSpend || "50");
    const me = await this.activeAddress(); const txs: Record<string, string> = {};
    const tx = async (name: string, to: Address, data: Hex) => { txs[name] = await this.sendTx(io, chain, to, data); };
    const baseAmount = toUnits(String(size), 10n ** BigInt(m.baseDecimals));

    // Sells need the ERC-20 the market lists; wrap whole ComputeTokens from the wallet to cover a shortfall.
    const ensureBase = async (need: bigint) => {
      const have = await c.readContract({ address: m.base, abi: erc20Abi, functionName: "balanceOf", args: [me] });
      if (have >= need) return;
      const unit = 10n ** BigInt(m.baseDecimals); const whole = (need - have + unit - 1n) / unit;
      const [token, id] = await Promise.all([c.readContract({ address: m.base, abi: wrapperAbi, functionName: "token" }), c.readContract({ address: m.base, abi: wrapperAbi, functionName: "id" })]);
      const held = await c.readContract({ address: token, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] }] as const, functionName: "balanceOf", args: [me, id] });
      if (held < whole) throw new CommandError("INSUFFICIENT_TOKENS", `The wallet holds ${Number(have) / Number(unit)} of the market's token and ${held} ComputeTokens of size ${id} to wrap; this order needs ${Number(need) / Number(unit)}.`, "Lower the size (Kuru's taker fee is taken from what a market buy delivers), or mint with `mm corpus mint`.");
      io.emit(`Wrapping ${whole} ComputeToken(s) into the market's ERC-20…`);
      if (!(await c.readContract({ address: token, abi: erc1155ApprovalAbi, functionName: "isApprovedForAll", args: [me, m.base] })))
        await tx("approveWrapper", token, encodeFunctionData({ abi: erc1155ApprovalAbi, functionName: "setApprovalForAll", args: [m.base, true] }));
      await tx("wrap", m.base, encodeFunctionData({ abi: wrapperAbi, functionName: "wrap", args: [whole] }));
    };
    const ensureAllowance = async (token: Address, spender: Address, amount: bigint, name: string) => {
      const a = await c.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [me, spender] });
      if (a < amount) await tx(name, token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }));
    };
    const ensureQuote = async (need: bigint) => {
      const bal = await c.readContract({ address: m.quote, abi: erc20Abi, functionName: "balanceOf", args: [me] });
      if (bal < need) throw new CommandError("INSUFFICIENT_USDC", `Need ${Number(need) / 10 ** m.quoteDecimals} USDC; the account holds ${Number(bal) / 10 ** m.quoteDecimals}.`, "Fund the account with USDC on Monad first.");
    };

    if (price === undefined || price === "") {
      // Market order: an IOC against resting liquidity, paid from the wallet (not the margin account).
      const book = await kuruBook(c, m);
      const notional = walk(s === "buy" ? book.asks : book.bids, qty);
      if (notional === null) throw new CommandError("NOT_ENOUGH_LIQUIDITY", `The book cannot fill ${qty} machines on the ${s === "buy" ? "ask" : "bid"} side.`, "Run `mm corpus book`, lower the size, or post a limit order with --price.");
      const avg = notional / qty;
      if (s === "buy") {
        if (notional > cap) throw new CommandError("MAX_SPEND_EXCEEDED", `This buy costs about ${notional.toFixed(2)} USDC, above --max-spend ${cap}.`, "Raise --max-spend to allow it.");
        const quoteAmount = toUnits(notional.toFixed(m.quoteDecimals), 10n ** BigInt(m.quoteDecimals));
        await ensureQuote(quoteAmount);
        io.emit(`Market buy ${qty} machines on Kuru, about ${notional.toFixed(2)} USDC (avg $${avg.toFixed(2)}).`);
        await ensureAllowance(m.quote, m.address, quoteAmount, "approveUsdc");
        const minOut = toUnits((qty * (1 - slip)).toFixed(m.baseDecimals), 10n ** BigInt(m.baseDecimals));
        await tx("order", m.address, encodeFunctionData({ abi: kuruBookAbi, functionName: "placeAndExecuteMarketBuy", args: [toUnits(notional.toFixed(6), m.pricePrecision), minOut, false, false] }));
      } else {
        await ensureBase(baseAmount);
        io.emit(`Market sell ${qty} machines on Kuru, about ${notional.toFixed(2)} USDC (avg $${avg.toFixed(2)}).`);
        await ensureAllowance(m.base, m.address, baseAmount, "approveBase");
        const minOut = toUnits((notional * (1 - slip)).toFixed(m.quoteDecimals), 10n ** BigInt(m.quoteDecimals));
        await tx("order", m.address, encodeFunctionData({ abi: kuruBookAbi, functionName: "placeAndExecuteMarketSell", args: [sizeUnits, minOut, false, false] }));
      }
      return { chainId: chain.chainId, market: m.address, side: s, type: "market", size: qty, estAvgPrice: +avg.toFixed(4), notionalUsdc: +notional.toFixed(2), txs };
    }

    // Limit order: funds come from Kuru's margin account, topped up from the wallet as needed.
    const px = Number(price); const priceUnits = toUnits(String(price), m.pricePrecision);
    if (!(px > 0) || priceUnits % m.tickSize !== 0n) {
      const tick = Number(m.tickSize) / Number(m.pricePrecision); const lo = Number(priceUnits / m.tickSize * m.tickSize) / Number(m.pricePrecision);
      throw new CommandError("OFF_TICK", `Price must be a multiple of the $${tick} tick.`, `Try ${lo} or ${+(lo + tick).toFixed(4)}.`);
    }
    const notional = px * qty; const post = String(postOnly ?? "").toLowerCase() === "true";
    if (s === "buy") {
      if (notional > cap) throw new CommandError("MAX_SPEND_EXCEEDED", `This order locks ${notional.toFixed(2)} USDC, above --max-spend ${cap}.`, "Raise --max-spend to allow it.");
      const need = toUnits(notional.toFixed(m.quoteDecimals), 10n ** BigInt(m.quoteDecimals));
      const inMargin = await c.readContract({ address: KURU[chain.chainId].margin, abi: kuruMarginAbi, functionName: "getBalance", args: [me, m.quote] });
      if (inMargin < need) {
        await ensureQuote(need - inMargin);
        io.emit(`Depositing ${Number(need - inMargin) / 10 ** m.quoteDecimals} USDC into Kuru's margin account…`);
        await ensureAllowance(m.quote, KURU[chain.chainId].margin, need - inMargin, "approveUsdc");
        await tx("deposit", KURU[chain.chainId].margin, encodeFunctionData({ abi: kuruMarginAbi, functionName: "deposit", args: [me, m.quote, need - inMargin] }));
      }
      io.emit(`Limit buy ${qty} machines @ $${px} on Kuru${post ? " (post-only)" : ""}.`);
      await tx("order", m.address, encodeFunctionData({ abi: kuruBookAbi, functionName: "addBuyOrder", args: [Number(priceUnits), sizeUnits, post] }));
    } else {
      const inMargin = await c.readContract({ address: KURU[chain.chainId].margin, abi: kuruMarginAbi, functionName: "getBalance", args: [me, m.base] });
      if (inMargin < baseAmount) {
        const short = baseAmount - inMargin; await ensureBase(short);
        io.emit(`Depositing ${Number(short) / 10 ** m.baseDecimals} machine(s) into Kuru's margin account…`);
        await ensureAllowance(m.base, KURU[chain.chainId].margin, short, "approveBase");
        await tx("deposit", KURU[chain.chainId].margin, encodeFunctionData({ abi: kuruMarginAbi, functionName: "deposit", args: [me, m.base, short] }));
      }
      io.emit(`Limit sell ${qty} machines @ $${px} on Kuru${post ? " (post-only)" : ""}.`);
      await tx("order", m.address, encodeFunctionData({ abi: kuruBookAbi, functionName: "addSellOrder", args: [Number(priceUnits), sizeUnits, post] }));
    }
    return { chainId: chain.chainId, market: m.address, side: s, type: "limit", size: qty, price: px, notionalUsdc: +notional.toFixed(2), txs };
  }
  override successHint(r: TradeResult): string {
    return `${r.type === "market" ? "Market" : "Limit"} ${r.side} ${r.size} machines${r.price ? ` @ $${r.price}` : r.estAvgPrice ? ` (~$${r.estAvgPrice} avg)` : ""} on Kuru. Order tx ${r.txs.order}`;
  }
}
