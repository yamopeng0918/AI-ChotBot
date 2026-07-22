import { describe, expect, it, vi } from "vitest";
import { KnowledgeRetriever, type AuthorizedKnowledgeChunk } from "../../src/retrieval/retriever";

const vid = (digit: string) => digit.repeat(64);
const row = (overrides: Partial<AuthorizedKnowledgeChunk> = {}): AuthorizedKnowledgeChunk => ({
  vectorId: vid("1"), chunkId: "c1", documentId: "d1", text: "Alpha beta gamma", displayName: "Guide.pdf",
  sourceUrl: null, pageNumber: 2, sectionPath: "Intro", paragraphIndex: null, segmentIndex: 0, ...overrides,
});
const make = (matches: unknown[], rows: AuthorizedKnowledgeChunk[], options = {}) => {
  const embed = vi.fn().mockResolvedValue([[1, 2]]), query = vi.fn().mockResolvedValue({ matches });
  const authorizeVectorIds = vi.fn().mockResolvedValue(rows);
  return { retriever: new KnowledgeRetriever({ embed }, { query }, { authorizeVectorIds }, options), embed, query, authorizeVectorIds };
};

describe("KnowledgeRetriever", () => {
  it("embeds once, chooses the best duplicate score, and emits stable chunk/vector identity plus segment location", async () => {
    const { retriever, embed, query, authorizeVectorIds } = make([
      { id: vid("2"), score: .8, metadata: { text: "evil" } }, { id: vid("1"), score: .9 },
      { id: vid("3"), score: .85 }, { id: vid("1"), score: .99 },
    ], [row(), row({ vectorId: vid("2"), chunkId: "c2", text: "Alpha beta gamma!", segmentIndex: 1 }),
      row({ vectorId: vid("3"), chunkId: "c3", documentId: "d0", text: "Different useful evidence", pageNumber: 1 })],
      { now: () => "2026-07-21T00:00:00.000Z" });
    const result = await retriever.retrieve("  useful question  ", 2);
    expect(embed).toHaveBeenCalledWith(["useful question"]); expect(query).toHaveBeenCalledWith([1, 2], 20);
    expect(authorizeVectorIds).toHaveBeenCalledWith([vid("1"), vid("3"), vid("2")]);
    expect(result.evidence.map((x) => x.id)).toEqual([`c1:${vid("1")}`, `c3:${vid("3")}`]);
    expect(result.evidence[0]).toMatchObject({ score: .99, segmentIndex: 0, retrievedAt: "2026-07-21T00:00:00.000Z" });
  });

  it("rejects every malformed candidate without querying D1", async () => {
    const { retriever, authorizeVectorIds } = make([
      null, [], "x", { id: "", score: .9 }, { id: " ".repeat(64), score: .9 }, { id: "g".repeat(64), score: .9 },
      { id: ` ${vid("1")}`, score: .9 }, { id: vid("1"), score: "0.9" }, { id: vid("1"), score: NaN },
      { id: vid("1"), score: Infinity }, { id: vid("1"), score: -Infinity },
    ], []);
    expect(await retriever.retrieve("question", 4)).toEqual({ evidence: [], insufficient: true, topScore: null });
    expect(authorizeVectorIds).not.toHaveBeenCalled();
  });

  it("orders score ties by document, page, paragraph, segment, then chunk", async () => {
    const ids = ["1","2","3","4","5"].map(vid);
    const rows = [
      row({ vectorId: ids[4], documentId:"b", pageNumber:1, paragraphIndex:0, segmentIndex:0, chunkId:"a", text:"five" }),
      row({ vectorId: ids[3], documentId:"a", pageNumber:2, paragraphIndex:0, segmentIndex:0, chunkId:"a", text:"four" }),
      row({ vectorId: ids[2], documentId:"a", pageNumber:1, paragraphIndex:2, segmentIndex:0, chunkId:"a", text:"three" }),
      row({ vectorId: ids[1], documentId:"a", pageNumber:1, paragraphIndex:1, segmentIndex:2, chunkId:"b", text:"two" }),
      row({ vectorId: ids[0], documentId:"a", pageNumber:1, paragraphIndex:1, segmentIndex:2, chunkId:"a", text:"one" }),
    ];
    const { retriever } = make(ids.map((id) => ({ id, score:.8 })), rows);
    expect((await retriever.retrieve("q", 8)).evidence.map((x) => x.text)).toEqual(["one","two","three","four","five"]);
  });

  it("dedupes same-document overlap at exactly .85 but not across documents", async () => {
    const common = Array.from({length:17}, (_,i) => `t${i}`).join(" ");
    const left = `${common} a b c`, right = common;
    const ids=[vid("1"),vid("2"),vid("3")];
    const { retriever }=make(ids.map((id,i)=>({id,score:.9-i*.01})),[
      row({vectorId:ids[0],text:left}), row({vectorId:ids[1],chunkId:"c2",text:right}),
      row({vectorId:ids[2],chunkId:"c3",documentId:"d2",text:right}),
    ]);
    expect((await retriever.retrieve("q",8)).evidence.map(x=>x.text)).toEqual([left,right]);
  });

  it.each([[1,1,20],[8,8,32],[99,8,32],[NaN,1,20],[Infinity,1,20]])("clamps limit %s to %s and topK %s", async (limit,count,topK) => {
    const ids=Array.from({length:8},(_,i)=>(i+1).toString().repeat(64));
    const {retriever,query}=make(ids.map((id)=>({id,score:.9})),ids.map((id,i)=>row({vectorId:id,chunkId:`c${i}`,documentId:`d${i}`,text:`text ${i}`})));
    expect((await retriever.retrieve("q",limit)).evidence).toHaveLength(count); expect(query).toHaveBeenCalledWith([1,2],topK);
  });

  it("honors injected score and overlap thresholds", async () => {
    const ids=[vid("1"),vid("2")];
    const {retriever}=make(ids.map((id)=>({id,score:.5})),[
      row({vectorId:ids[0],text:"a b c"}),row({vectorId:ids[1],chunkId:"c2",text:"a b d"}),
    ],{scoreThreshold:.5,overlapThreshold:.5});
    expect((await retriever.retrieve("q",8)).evidence).toHaveLength(1);
  });
});
