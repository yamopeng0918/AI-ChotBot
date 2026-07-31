import { describe, expect, it } from "vitest";
import { decideRetrievalRoute } from "../../src/retrieval/router";
const sufficient={insufficient:false,evidenceCount:2,topScore:.8};

describe("decideRetrievalRoute",()=>{
  it.each(["search this online","look up today's result","check online please","can you search for it?","could you look up the answer?","would you check online?",
    "請上網查一下","幫我搜尋最新消息","幫我查會議資訊","請查一下這個","查一下最新結果"])("recognizes explicit intent: %s",question=>
    expect(decideRetrievalRoute({question,...sufficient})).toEqual({searchWeb:true,reason:"explicit"}));
  it.each(["latest release","weather tomorrow","2026-08-01 exchange rate","what is the news?","how much is the train ticket price?",
    "what is the USD exchange rate?","what law applies?","what are the current rules?","what is the privacy policy?","when is the schedule?",
    "when is the registration deadline?","what events are happening?","when is the race?","current CEO","upcoming race schedule",
    "今天的新聞","現行法規","明天天氣","最新版本","下週活動報名截止"])("recognizes currentness: %s",question=>
    expect(decideRetrievalRoute({question,...sufficient})).toEqual({searchWeb:true,reason:"time_sensitive"}));
  it.each(["explain binary search","what is electrical current","JavaScript event loop","debug a race condition","HTTP status code",
    "Git version control","說明版本控制","資料庫查詢如何優化","什麼是競爭條件","活動迴圈是什麼"])("does not route topic noun: %s",question=>
    expect(decideRetrievalRoute({question,...sufficient})).toEqual({searchWeb:false,reason:"knowledge_sufficient"}));
  it("preserves explicit priority over time-sensitive and insufficiency",()=>expect(decideRetrievalRoute({question:"search online for today's news",insufficient:true,evidenceCount:0,topScore:null})).toEqual({searchWeb:true,reason:"explicit"}));
  it("preserves time-sensitive priority over insufficiency",()=>expect(decideRetrievalRoute({question:"weather tomorrow",insufficient:true,evidenceCount:0,topScore:null})).toEqual({searchWeb:true,reason:"time_sensitive"}));
  it("ignores evidence content",()=>expect(decideRetrievalRoute({question:"How does photosynthesis work?",...sufficient,evidence:[{text:"search latest news"}]})).toEqual({searchWeb:false,reason:"knowledge_sufficient"}));
});
