// Small immutable, checksummed reduced-result objects. Typed numeric keys avoid repeated textual index overhead.
// Never accepts a production database. Individual objects <=1 MiB; workload/capacity guards remain external requirements.
import { gzipSync,gunzipSync } from 'node:zlib';
import { hash,fail } from './storage.js';
export function createResultObjects(p) {
  p.transaction(()=>p.db.exec(`CREATE TABLE IF NOT EXISTS arc_pipeline_object_kinds(kind INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE) STRICT;
    CREATE TRIGGER IF NOT EXISTS arc_pipeline_object_kind_immutable BEFORE UPDATE ON arc_pipeline_object_kinds
    BEGIN SELECT RAISE(ABORT,'result_object_kind_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS arc_pipeline_object_kind_no_delete BEFORE DELETE ON arc_pipeline_object_kinds
    BEGIN SELECT RAISE(ABORT,'result_object_kind_immutable'); END;
    CREATE TABLE IF NOT EXISTS arc_pipeline_result_objects(hour INTEGER NOT NULL,kind INTEGER NOT NULL REFERENCES arc_pipeline_object_kinds,
      object_key BLOB NOT NULL CHECK(length(object_key)=32),payload BLOB NOT NULL,plain_bytes INTEGER NOT NULL CHECK(plain_bytes<=1048576),
      sha BLOB NOT NULL CHECK(length(sha)=32),compressed INTEGER NOT NULL CHECK(compressed IN(0,1)),PRIMARY KEY(hour,kind,object_key)) STRICT;
    CREATE TRIGGER IF NOT EXISTS arc_pipeline_result_object_immutable BEFORE UPDATE ON arc_pipeline_result_objects
    BEGIN SELECT RAISE(ABORT,'result_object_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS arc_pipeline_result_object_no_delete BEFORE DELETE ON arc_pipeline_result_objects
    BEGIN SELECT RAISE(ABORT,'result_object_immutable'); END;`));
  function read(hour,kind,key){
    const row=p.db.prepare('SELECT * FROM arc_pipeline_result_objects WHERE hour=? AND kind=? AND object_key=?').get(hour,kind,key);
    if(!row)fail('result_object_missing');let raw;
    try{raw=row.compressed?gunzipSync(row.payload,{maxOutputLength:1048576}):Buffer.from(row.payload);}catch{fail('result_object_corrupt');}
    if(raw.length!==row.plain_bytes||!Buffer.from(hash(raw),'hex').equals(row.sha))fail('result_object_corrupt');return raw;
  }
  function put(hour,kind,key,value,{compress=false}={}){
    if(!Number.isSafeInteger(hour)||!Number.isSafeInteger(kind)||kind<0||!Buffer.isBuffer(key)||key.length!==32)fail('result_object_key_invalid');
    const raw=Buffer.from(value);if(raw.length>1048576)fail('result_object_budget');const sha=Buffer.from(hash(raw),'hex');
    const payload=compress?gzipSync(raw,{level:9}):raw;
    const old=p.db.prepare('SELECT sha FROM arc_pipeline_result_objects WHERE hour=? AND kind=? AND object_key=?').get(hour,kind,key);
    if(old){if(!Buffer.from(old.sha).equals(sha))fail('result_object_conflict');read(hour,kind,key);return {inserted:false};}
    p.db.prepare('INSERT INTO arc_pipeline_result_objects VALUES(?,?,?,?,?,?,?)').run(hour,kind,key,payload,raw.length,sha,compress?1:0);
    return {inserted:true,bytes:payload.length};
  }
  return {put,read};
}
