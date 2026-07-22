import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import m1 from "../../migrations/0001_questions.sql?raw"; import m2 from "../../migrations/0002_knowledge.sql?raw";
import m3 from "../../migrations/0003_upload_claim_fencing.sql?raw"; import m4 from "../../migrations/0004_url_snapshots.sql?raw";
import m5 from "../../migrations/0005_ingestion_lifecycle.sql?raw"; import m6 from "../../migrations/0006_knowledge_chunk_segments.sql?raw";
import { KnowledgeRepository } from "../../src/knowledge/repository";

describe("KnowledgeRepository retrieval authorization",()=>{
  let mf:Miniflare,db:D1Database,repository:KnowledgeRepository;
  beforeEach(async()=>{
    mf=new Miniflare({modules:true,script:"export default {fetch(){return new Response('ok')}}",d1Databases:["DB"]}); db=await mf.getD1Database("DB");
    for(const sql of [m1,m2,m3,m4,m5,m6]) await db.batch(sql.split(";").map(x=>x.trim()).filter(Boolean).map(x=>db.prepare(x)));
    await db.prepare(`INSERT INTO knowledge_documents(id,source_type,display_name,source_url,r2_key,active_version,status,created_at,updated_at) VALUES
      ('ready','url','Ready','https://example.com',NULL,2,'ready','n','n'),('stale','file','Stale',NULL,'s',2,'ready','n','n'),
      ('deleting','file','Deleting',NULL,'d',1,'deleting','n','n'),('failed','file','Failed',NULL,'f',1,'failed','n','n')`).run();
    await db.prepare(`INSERT INTO knowledge_chunks(id,document_id,index_version,text,page_number,section_path,paragraph_index,segment_index,vector_id,content_hash,created_at) VALUES
      ('c-ready','ready',2,'authorized',3,'A',4,5,'vec-ready','h','n'),('c-old','ready',1,'old',1,NULL,NULL,0,'vec-old','h','n'),
      ('c-stale','stale',1,'stale',1,NULL,NULL,0,'vec-stale','h','n'),('c-del','deleting',1,'del',1,NULL,NULL,0,'vec-del','h','n'),
      ('c-fail','failed',1,'fail',1,NULL,NULL,0,'vec-fail','h','n')`).run(); repository=new KnowledgeRepository(db);
  }); afterEach(()=>mf.dispose());

  it("binds exact IDs and maps D1 source and complete location",async()=>{
    expect(await repository.authorizeVectorIds(["vec-ready","' OR 1=1 --"])).toEqual([{
      vectorId:"vec-ready",chunkId:"c-ready",documentId:"ready",text:"authorized",displayName:"Ready",sourceUrl:"https://example.com",
      pageNumber:3,sectionPath:"A",paragraphIndex:4,segmentIndex:5,
    }]);
  });
  it("excludes stale versions and non-ready documents",async()=>expect(await repository.authorizeVectorIds(["vec-old","vec-stale","vec-del","vec-fail"])).toEqual([]));
  it("deduplicates repeated vector IDs",async()=>expect(await repository.authorizeVectorIds(["vec-ready","vec-ready"])).toHaveLength(1));
  it("fails closed when a vector ID maps to multiple eligible active chunks",async()=>{
    await db.prepare(`INSERT INTO knowledge_documents(id,source_type,display_name,r2_key,active_version,status,created_at,updated_at)
      VALUES ('other','file','Other','o',1,'ready','n','n')`).run();
    await db.prepare(`INSERT INTO knowledge_chunks(id,document_id,index_version,text,segment_index,vector_id,content_hash,created_at)
      VALUES ('c-other','other',1,'fanout',0,'vec-ready','h','n')`).run();
    expect(await repository.authorizeVectorIds(["vec-ready","vec-ready"])).toEqual([]);
  });
  it("returns deduplicated authorized mappings deterministically",async()=>{
    await db.prepare(`INSERT INTO knowledge_chunks(id,document_id,index_version,text,segment_index,vector_id,content_hash,created_at)
      VALUES ('c-second','ready',2,'second',0,'vec-z','h','n')`).run();
    expect((await repository.authorizeVectorIds(["vec-z","vec-ready","vec-z"])).map(x=>x.vectorId)).toEqual(["vec-ready","vec-z"]);
  });
});
