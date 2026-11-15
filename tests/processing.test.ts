import test from 'node:test';import assert from 'node:assert/strict';
import{extractUtf8,validateTranscript,processingJobKey}from'../src/index.ts';import{hashBytes}from'../src/contracts.ts';import type{Context}from'../src/contracts.ts';
const ctx:Context={tenantId:'alpha',projectId:'study',actor:{id:'worker',kind:'service',roles:['researcher']},purpose:'research',requestId:'r',now:'2026-01-01T00:00:00Z'};
const bytes=Buffer.from('Fictional source');const source={tenantId:'alpha',projectId:'study',kind:'evidence',id:'one',revision:1};const input={source,sha256:hashBytes(bytes),scanStatus:'clean' as const,processingAllowed:true,bytes};
test('text derivative preserves exact source edition and processor provenance',()=>{const r=extractUtf8(ctx,input,'en');assert.equal(r.text,'Fictional source');assert.deepEqual(r.source,source);assert.equal(r.sourceSha256,input.sha256);assert.equal(r.processorVersion,'1.0.0');assert.equal(r.language,'en');});
test('authorization quarantine integrity and tenant controls fail closed',()=>{for(const value of[{...input,processingAllowed:false},{...input,scanStatus:'failed' as const},{...input,scanStatus:'quarantined' as const},{...input,sha256:'0'.repeat(64)},{...input,source:{...source,tenantId:'beta'}}])assert.throws(()=>extractUtf8(ctx,value));});
test('malformed UTF8 NUL and oversized text cannot silently become valid text',()=>{for(const b of[Buffer.from([0xc3,0x28]),Buffer.from('abc\u0000def'),Buffer.alloc(5*1024*1024+1)])assert.throws(()=>extractUtf8(ctx,{...input,bytes:b,sha256:hashBytes(b)}));});
test('transcript segments require ordered bounded intervals and honest confidence',()=>{validateTranscript([{startMs:0,endMs:100,text:'A fictional sentence',speaker:null,confidence:null}],100);for(const seg of[{startMs:-1,endMs:10,text:'x',speaker:null,confidence:1},{startMs:0,endMs:101,text:'x',speaker:null,confidence:1},{startMs:0,endMs:10,text:'x',speaker:null,confidence:1.1},{startMs:5,endMs:5,text:'x',speaker:null,confidence:null}])assert.throws(()=>validateTranscript([seg],100));});
test('job identity changes with source revision configuration and adapter version',()=>{const adapter={id:'transcript',version:'1',operations:['transcription' as const],inputMimeTypes:['audio/wav'],remote:false};const a=processingJobKey(source,input.sha256,adapter,'transcription',{language:'en'});assert.equal(a,processingJobKey(source,input.sha256,adapter,'transcription',{language:'en'}));assert.notEqual(a,processingJobKey({...source,revision:2},input.sha256,adapter,'transcription',{language:'en'}));assert.notEqual(a,processingJobKey(source,input.sha256,{...adapter,version:'2'},'transcription',{language:'en'}));assert.throws(()=>processingJobKey(source,input.sha256,adapter,'ocr',{}));});

test('runtime processing permission must be the literal true boolean',()=>{
 for(const processingAllowed of ['false','true',1,{},[],null,undefined])
  assert.throws(()=>extractUtf8(ctx,{...input,processingAllowed} as any),{code:'processing_denied'});
});

test('bytes and source hash are read once and bound to a detached verified byte snapshot',()=>{
 const checked=Buffer.from('verified bytes'),changed=Buffer.from('unverified text');let reads=0;
 const candidate={...input,sha256:hashBytes(checked),get bytes(){return ++reads<=2?checked:changed;}};
 const result=extractUtf8(ctx,candidate);
 assert.equal(reads,1);assert.equal(result.text,'verified bytes');assert.equal(result.sha256,hashBytes(checked));
});

test('the output source is the same exact validated reference that passed tenant admission',()=>{
 let reads=0;
 const candidate={...input,get source(){return ++reads===1?source:{...source,tenantId:'beta'};}};
 const result=extractUtf8(ctx,candidate);
 assert.equal(reads,1);assert.deepEqual(result.source,source);
});

test('malformed source revisions and references cannot produce trusted derivative provenance',()=>{
 for(const bad of [{...source,revision:0},{...source,revision:1.5},{...source,id:''},{...source,unexpected:true}])
  assert.throws(()=>extractUtf8(ctx,{...input,source:bad}));
});

test('source hash provenance is read once and cannot change after verification',()=>{
 let reads=0;
 const candidate={...input,get sha256(){return ++reads===1?input.sha256:'0'.repeat(64);}};
 const result=extractUtf8(ctx,candidate);assert.equal(reads,1);assert.equal(result.sourceSha256,input.sha256);
});

test('plain arrays and other non-byte containers cannot be implicitly decoded',()=>{
 for(const value of [[65,66],new ArrayBuffer(4),null,{}])
  assert.throws(()=>extractUtf8(ctx,{...input,bytes:value} as any),{code:'invalid_text'});
});
