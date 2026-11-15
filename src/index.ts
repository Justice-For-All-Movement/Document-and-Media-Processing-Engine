import{hashBytes,digest,invariant,requireScope,validTime,nonempty,validateRef}from'./contracts.ts';import type{Context,Ref}from'./contracts.ts';
export interface ProcessingInput{source:Ref;sha256:string;scanStatus:'quarantined'|'clean'|'failed'|'infected';processingAllowed:boolean;bytes:Uint8Array;}
export interface TextDerivative{source:Ref;sourceSha256:string;sha256:string;text:string;language:string|null;processor:string;processorVersion:string;createdAt:string;warnings:readonly string[];}
export function extractUtf8(ctx:Context,input:ProcessingInput,language:string|null=null):TextDerivative{
 const context=structuredClone(ctx);
 const source=validateRef(structuredClone(input.source));
 requireScope(context,source);validTime(context.now);
 invariant(input.processingAllowed===true,'processing_denied','Processing purpose is not authorized');
 invariant(input.scanStatus==='clean','quarantined','Only clean bytes can be processed');
 // Capture each caller-owned field once. Hash and decode the same detached bytes.
 const suppliedBytes=input.bytes,sourceSha256=input.sha256;
 invariant(suppliedBytes instanceof Uint8Array,'invalid_text','Text bytes must be a Uint8Array');
 invariant(suppliedBytes.byteLength<=5*1024*1024,'processing_too_large','Text extraction maximum is5MiB');
 const bytes=new Uint8Array(suppliedBytes);
 invariant(hashBytes(bytes)===sourceSha256,'integrity_failure','Processing input hash mismatch');
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 invariant(!text.includes('\u0000'),'invalid_text','NUL bytes are not plain text');
 return {source,sourceSha256,sha256:hashBytes(Buffer.from(text)),text,language,processor:'utf8-text',processorVersion:'1.0.0',createdAt:context.now,warnings:[]};
}
export interface TranscriptSegment{startMs:number;endMs:number;text:string;speaker:string|null;confidence:number|null;}
export function validateTranscript(segments:readonly TranscriptSegment[],durationMs:number):void{invariant(Number.isSafeInteger(durationMs)&&durationMs>0,'invalid_duration','Positive media duration required');let last=-1;for(const s of segments){invariant(Number.isSafeInteger(s.startMs)&&Number.isSafeInteger(s.endMs)&&s.startMs>=0&&s.startMs>=last&&s.endMs>s.startMs&&s.endMs<=durationMs,'invalid_segment','Invalid transcript time range');nonempty(s.text,'transcript text',10000);invariant(s.confidence===null||(Number.isFinite(s.confidence)&&s.confidence>=0&&s.confidence<=1),'invalid_confidence','Confidence must be0-1or unknown');last=s.startMs;}}
export interface ProcessingAdapter {id:string;version:string;operations:readonly('ocr'|'transcription'|'translation')[];inputMimeTypes:readonly string[];remote:boolean;}
export function processingJobKey(source:Ref,sha256:string,adapter:ProcessingAdapter,operation:string,configuration:unknown):string{invariant(adapter.operations.includes(operation as 'ocr'),'unsupported_operation','Adapter operation unsupported');return digest({source,sha256,adapterId:adapter.id,adapterVersion:adapter.version,operation,configuration});}
