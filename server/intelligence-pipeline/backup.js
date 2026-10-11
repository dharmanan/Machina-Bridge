// Filesystem backup/restore for opt-in isolated pipeline databases. No remote service or paid storage.
// An independent production backup destination is an operator dependency, never inferred from this local adapter.
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, openSync, closeSync, readSync, writeSync, fsyncSync, readFileSync, writeFileSync, unlinkSync, existsSync, linkSync, realpathSync, statSync, lstatSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { PIPELINE_VERSION, hash, json, fail, assertHeapBudget } from './storage.js';
const PART_BYTES=4*1024*1024;
async function fileHash(path){const h=createHash('sha256');for await(const b of createReadStream(path,{highWaterMark:65536}))h.update(b);return h.digest('hex');}
function marker(db){const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));if(!tables.has('arc_pipeline_meta')||db.prepare("SELECT value FROM arc_pipeline_meta WHERE key='version'").get()?.value!==PIPELINE_VERSION)fail('independent_database_marker_required');}
function integrity(db){const r=db.prepare('PRAGMA integrity_check').all();if(r.length!==1||r[0].integrity_check!=='ok')fail('backup_integrity_failed');if(db.prepare('PRAGMA foreign_key_check').all().length)fail('backup_foreign_key_failed');}
function exclusiveWrite(path,data){const fd=openSync(path,'wx',0o600);try{writeFileSync(fd,data);fsyncSync(fd);}finally{closeSync(fd);}}
export async function backupPipeline(p,{targetDirectory,guard}={}){
  assertHeapBudget();
  if(typeof guard!=='function')fail('backup_capacity_guard_required');
  targetDirectory=realpathSync(targetDirectory);if(targetDirectory===p.directory||targetDirectory.startsWith(p.directory+'/'))fail('separate_backup_directory_required');
  const snapshot=join(targetDirectory,'.snapshot-'+randomUUID()+'.partial');
  const source=new DatabaseSync(p.path,{readOnly:true});source.exec('PRAGMA query_only=ON');
  try{
    marker(source);const estimate=source.prepare('PRAGMA page_count').get().page_count*source.prepare('PRAGMA page_size').get().page_size;guard(estimate);
    await backup(source,snapshot,{rate:128,progress:()=>guard(0)});
  }catch(e){if(existsSync(snapshot))unlinkSync(snapshot);throw e;}finally{source.close();}
  try{
    // Compact the disposable backup copy, not its source. Free pages may contain obsolete staging bytes;
    // preserving them in a backup would turn temporary inputs into a permanent duplicate archive.
    const packed=snapshot+'.packed';const copy=new DatabaseSync(snapshot);
    try{marker(copy);guard(statSync(snapshot).size);copy.exec('PRAGMA cache_size=-2048; PRAGMA temp_store=FILE');copy.prepare('VACUUM INTO ?').run(packed);}
    finally{copy.close();}
    guard(0);
    unlinkSync(snapshot);linkSync(packed,snapshot);unlinkSync(packed);
    const check=new DatabaseSync(snapshot,{readOnly:true});try{check.exec('PRAGMA query_only=ON');marker(check);integrity(check);}finally{check.close();}
    const parts=[],fd=openSync(snapshot,'r'),buffer=Buffer.alloc(PART_BYTES);let size=0;
    try{for(;;){const n=readSync(fd,buffer,0,PART_BYTES,null);if(!n)break;if(parts.length>=1024)fail('backup_part_limit');const plain=buffer.subarray(0,n),compressed=gzipSync(plain,{level:3}),sha=hash(compressed),name=sha+'.gz',path=join(targetDirectory,name);guard(compressed.length);
      if(existsSync(path)){if(await fileHash(path)!==sha)fail('backup_existing_part_corrupt');}else exclusiveWrite(path,compressed);guard(0);
      if(!gunzipSync(readFileSync(path),{maxOutputLength:PART_BYTES}).equals(plain))fail('backup_part_verification_failed');
      parts.push({name,sha,plainSha:hash(plain),bytes:compressed.length,plainBytes:n});size+=n;
    }}finally{closeSync(fd);}
    const manifest={format:'arc-independent-backup-v1',pipelineVersion:PIPELINE_VERSION,snapshotSha:await fileHash(snapshot),snapshotBytes:size,parts},text=json(manifest),manifestSha=hash(text),path=join(targetDirectory,manifestSha+'.json');guard(Buffer.byteLength(text));
    if(existsSync(path)){if(hash(readFileSync(path))!==manifestSha)fail('backup_existing_manifest_corrupt');}else exclusiveWrite(path,text);
    const dirFd=openSync(targetDirectory,'r');try{fsyncSync(dirFd);}finally{closeSync(dirFd);}
    return {manifestPath:path,manifestSha,snapshotBytes:size,storedPartBytes:parts.reduce((n,r)=>n+r.bytes,0),parts:parts.length,destinationIsSeparateDirectory:true,offVolumeOrRemoteDurabilityProven:false};
  }finally{if(existsSync(snapshot))unlinkSync(snapshot);if(existsSync(snapshot+'.packed'))unlinkSync(snapshot+'.packed');}
}
export async function restorePipeline({manifestPath,expectedManifestSha,destination,guard,verifyDatabase}={}){
  assertHeapBudget();
  if(typeof guard!=='function'||typeof verifyDatabase!=='function')fail('restore_verification_and_capacity_required');
  if(!/^[0-9a-f]{64}$/.test(expectedManifestSha??''))fail('trusted_manifest_sha_required');
  manifestPath=resolve(manifestPath);if(statSync(manifestPath).size>1024*1024||lstatSync(manifestPath).isSymbolicLink())fail('backup_manifest_corrupt');const text=readFileSync(manifestPath);if(hash(text)!==expectedManifestSha)fail('backup_manifest_corrupt');const m=JSON.parse(text);
  if(m.format!=='arc-independent-backup-v1'||m.pipelineVersion!==PIPELINE_VERSION||!Array.isArray(m.parts)||m.parts.length>1024)fail('backup_manifest_invalid');
  destination=join(realpathSync(dirname(resolve(destination))),resolve(destination).split('/').at(-1));if(existsSync(destination)||existsSync(destination+'-wal')||existsSync(destination+'-shm'))fail('restore_requires_empty_destination');
  guard(m.snapshotBytes);const partial=destination+'.restore-'+randomUUID()+'.partial',fd=openSync(partial,'wx',0o600);let bytes=0;
  try{
    for(const part of m.parts){if(part.name!==part.sha+'.gz'||!/^[0-9a-f]{64}$/.test(part.sha)||!Number.isInteger(part.bytes)||part.bytes<1||part.bytes>PART_BYTES+65536||!Number.isInteger(part.plainBytes)||part.plainBytes<1||part.plainBytes>PART_BYTES)fail('backup_part_invalid');
      const path=join(dirname(manifestPath),part.name);if(lstatSync(path).isSymbolicLink()||statSync(path).size!==part.bytes)fail('backup_part_corrupt');const compressed=readFileSync(path);if(hash(compressed)!==part.sha)fail('backup_part_corrupt');const plain=gunzipSync(compressed,{maxOutputLength:PART_BYTES});if(plain.length!==part.plainBytes||hash(plain)!==part.plainSha)fail('backup_part_corrupt');guard(plain.length);let at=0;while(at<plain.length)at+=writeSync(fd,plain,at,plain.length-at);bytes+=plain.length;
    }fsyncSync(fd);
  }catch(e){closeSync(fd);if(existsSync(partial))unlinkSync(partial);throw e;}closeSync(fd);
  try{
    if(bytes!==m.snapshotBytes||await fileHash(partial)!==m.snapshotSha)fail('backup_snapshot_corrupt');
    const db=new DatabaseSync(partial,{readOnly:true});try{db.exec('PRAGMA query_only=ON');marker(db);integrity(db);verifyDatabase(db);}finally{db.close();}
    // Exclusive publication: a competing creator or dangling symlink can never be overwritten.
    linkSync(partial,destination);unlinkSync(partial);const d=openSync(dirname(destination),'r');try{fsyncSync(d);}finally{closeSync(d);}
    return {destination,snapshotSha:m.snapshotSha,bytes,restored:true};
  }finally{if(existsSync(partial))unlinkSync(partial);}
}
