import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MaterialFile } from '../../shared/automation.js';
import { GenerationInputError } from './errors.js';

interface Pixels { width:number; height:number; data:Buffer }
// Playwright is pinned and already ships this exported, pure-JS PNG codec on every supported platform.
const {PNG}=createRequire(import.meta.url)('playwright-core/lib/utilsBundle') as {PNG:{sync:{read:(bytes:Buffer,options:{checkCRC:boolean})=>Pixels;write:(image:Pixels)=>Buffer}}};
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export const repairImagePolicy={version:2,maxSide:2048,maxPixels:64_000_000,maxImages:20,maxBytes:16*1024*1024};
export interface RepairImageSource { file:MaterialFile; bytes:Buffer; reportId:string }

/** Decode before sending. Keep all vertical regions; fail explicitly rather than silently dropping image evidence. */
export function adaptRepairImages(sources:RepairImageSource[],directory:string){
  mkdirSync(directory,{recursive:true,mode:0o700});
  const images:{uri:string;mediaType:'image/png'}[]=[],mapping:{sourceReportId:string;sourceName:string;sourceHash:string;sourceWidth:number;sourceHeight:number;region:{x:number;y:number;width:number;height:number};file:string;sha256:string;width:number;height:number}[]=[];
  const batches:{images:typeof images;mapping:typeof mapping;label:string}[]=[];
  let batchBytes=0;
  const batchLabel=(items:typeof mapping)=>'\n本批修复图片按附件顺序切片，原图与区域映射：'+items.map((item,index)=>`${index+1}=${item.sourceName} y=${item.region.y}..${item.region.y+item.region.height} / 原高${item.sourceHeight}`).join('；')+'。分片边界不是页面布局边界，按同名原图顺序连续查看。';
  for(const source of sources){
    const bytes=source.bytes;
    if(bytes.length<33||bytes.length!==source.file.size||hash(bytes)!==source.file.sha256||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.subarray(12,16).toString()!=='IHDR')throw new GenerationInputError(`修复图片校验失败：${source.file.name}；未发送`);
    const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
    if(!width||!height||width*height>repairImagePolicy.maxPixels||bytes.length>repairImagePolicy.maxBytes)throw new GenerationInputError(`修复图片超过解码预算：${source.file.name} (${width}×${height})；未发送`);
    let original:Pixels;try{original=PNG.sync.read(bytes,{checkCRC:true});}catch{throw new GenerationInputError(`修复图片无法解码：${source.file.name}；未发送`);}
    const scale=Math.min(1,repairImagePolicy.maxSide/width),outWidth=Math.max(1,Math.floor(width*scale)),sourceStep=Math.max(1,Math.floor(repairImagePolicy.maxSide/scale));
    for(let y=0;y<height;y+=sourceStep){
      const regionHeight=Math.min(sourceStep,height-y),outHeight=Math.max(1,Math.floor(regionHeight*scale)),pixels:Pixels={width:outWidth,height:outHeight,data:Buffer.alloc(outWidth*outHeight*4)};
      // Linear interpolation only when a very wide screenshot must be reduced. Normal PC/mobile screenshots retain native pixels.
      if(scale===1)original.data.copy(pixels.data,0,y*width*4,(y+regionHeight)*width*4);
      else for(let dy=0;dy<outHeight;dy++)for(let dx=0;dx<outWidth;dx++){
        const sx=dx/scale,sy=y+dy/scale,x0=Math.min(width-1,Math.floor(sx)),y0=Math.min(height-1,Math.floor(sy)),x1=Math.min(width-1,x0+1),y1=Math.min(y+regionHeight-1,y0+1),fx=sx-x0,fy=sy-y0;
        for(let c=0;c<4;c++)pixels.data[(dy*outWidth+dx)*4+c]=Math.round(original.data[(y0*width+x0)*4+c]*(1-fx)*(1-fy)+original.data[(y0*width+x1)*4+c]*fx*(1-fy)+original.data[(y1*width+x0)*4+c]*(1-fx)*fy+original.data[(y1*width+x1)*4+c]*fx*fy);
      }
      const encoded=PNG.sync.write(pixels),encodedBytes=4*Math.ceil(encoded.length/3);
      if(encodedBytes>repairImagePolicy.maxBytes)throw new GenerationInputError('单张修复切片超过请求图片预算；未发送');
      const digest=hash(encoded),name=digest+'.png';writeFileSync(resolve(directory,name),encoded,{mode:0o600});
      mapping.push({sourceReportId:source.reportId,sourceName:source.file.name,sourceHash:source.file.sha256,sourceWidth:width,sourceHeight:height,region:{x:0,y,width,height:regionHeight},file:name,sha256:digest,width:outWidth,height:outHeight});
      images.push({uri:'data:image/png;base64,'+encoded.toString('base64'),mediaType:'image/png'});
      let batch=batches.at(-1);
      if(!batch||batch.images.length>=repairImagePolicy.maxImages||batchBytes+encodedBytes>repairImagePolicy.maxBytes){batch={images:[],mapping:[],label:''};batches.push(batch);batchBytes=0;}
      batch.images.push(images.at(-1)!);batch.mapping.push(mapping.at(-1)!);batchBytes+=encodedBytes;
    }
  }
  writeFileSync(resolve(directory,'mapping.json'),JSON.stringify({policy:repairImagePolicy,images:mapping},null,2),{mode:0o600});
  for(const batch of batches)batch.label=batchLabel(batch.mapping);
  const planKey=hash(Buffer.from(JSON.stringify([repairImagePolicy,mapping])));
  return {images,mapping,batches,planKey,label:batchLabel(mapping)};
}
