// Exact, versioned codec for repeated packed verified memberships. Reuses the canonical address dictionary.
// The original JSON checksum remains the authority; field order, types, nulls and address order all round-trip.
import { fail } from './storage.js';
export function packedMemberships(db, value) {
  db.exec(`CREATE TABLE IF NOT EXISTS arc_pipeline_addresses(id INTEGER PRIMARY KEY,address BLOB NOT NULL UNIQUE CHECK(length(address)=20)) STRICT;
    CREATE TRIGGER IF NOT EXISTS arc_pipeline_address_immutable BEFORE UPDATE ON arc_pipeline_addresses BEGIN SELECT RAISE(ABORT,'verified_address_immutable'); END;
    CREATE TRIGGER IF NOT EXISTS arc_pipeline_address_no_delete BEFORE DELETE ON arc_pipeline_addresses BEGIN SELECT RAISE(ABORT,'verified_address_immutable'); END;`);
  const insert=db.prepare('INSERT OR IGNORE INTO arc_pipeline_addresses(address) VALUES(?)'),get=db.prepare('SELECT id FROM arc_pipeline_addresses WHERE address=?');
  const found=new Map();let total=0;
  const visit=(node,eligible=false)=>{
    if(eligible&&typeof node==='string'){
      if(found.has(node))return;
      const raw=Buffer.from(node,'base64');
      if(raw.toString('base64')!==node||raw.length%20||raw.length>2000000)fail('membership_codec_invalid');
      const ids=[];
      for(let at=0;at<raw.length;at+=20){const address=raw.subarray(at,at+20);insert.run(address);ids.push(get.get(address).id);if(++total>100000)fail('membership_codec_budget');}
      found.set(node,ids);
    }else if(node&&typeof node==='object')for(const[k,v]of Object.entries(node))visit(v,k==='membership'||/Membership$/.test(k)||eligible);
  };
  visit(value);return found;
}
export function membershipAddressReader(db) {
  const get=db.prepare('SELECT address FROM arc_pipeline_addresses WHERE id=?');
  return id=>{const raw=get.get(id)?.address;if(!raw||raw.length!==20)fail('membership_codec_corrupt');return Buffer.from(raw);};
}
