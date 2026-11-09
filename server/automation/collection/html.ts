import { decodeHTML, decodeHTMLAttribute, decodeHTMLStrict } from 'entities';

const norm=(value:string)=>value.normalize('NFC').replace(/[\s\u00a0\u3000]+/g,' ').trim();
const blocks=new Set('address article aside blockquote dd div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tbody td th thead tr ul'.split(' '));
const voids=new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const prose=new Set('p h1 h2 h3 h4 h5 h6 blockquote pre figcaption dt dd td th'.split(' '));
export interface CollectionTextFragment {text:string;visible:boolean;region:'content'|'navigation';linkUrl?:string}

/** Inert source/target text parsing. No scripts, browser, model or target code execute. */
export function collectionHtml(value:string,base:string){
  let unsupported=false;
  const decode=(text:string,attribute=false)=>{
    for(const match of text.matchAll(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi)){
      const name=match[1];
      if(name[0]==='#'){
        const code=name[1]?.toLowerCase()==='x'?parseInt(name.slice(2),16):Number(name.slice(1));
        if(!code||code>0x10ffff||code>=0xd800&&code<=0xdfff)unsupported=true;
      }else if(decodeHTMLStrict(match[0])===match[0])unsupported=true;
    }
    return attribute?decodeHTMLAttribute(text):decodeHTML(text);
  };
  const clean=value.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'');
  const title=norm(decode((/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(clean)?.[1]||'').replace(/<\/?[a-z][^>]*>/gi,'')));
  const links:{url:string;text:string;where:string}[]=[],segments:string[]=[],semanticFragments:CollectionTextFragment[]=[],stack:{tag:string;region:boolean;skip:boolean;inert:boolean;icon:boolean;atomicAnchor:boolean}[]=[];
  let text='',allText='',chunk='',anchor:{url:string;text:string;where:string}|undefined,documentBase=base,baseSeen=false;
  let semantic:CollectionTextFragment|undefined;
  let semanticText='',semanticVisibleText='';
  let semanticAnchor:CollectionTextFragment|undefined;
  const flushSemantic=()=>{if(semantic&&norm(semantic.text))semanticFragments.push({...semantic,text:norm(semantic.text)});semantic=undefined;};
  const semanticContent=(decoded:string)=>{
    if(stack.some(s=>s.inert))return;
    // Private-use iconfont codepoints are decoration only inside explicit icon markup.
    if(stack.some(s=>s.icon))decoded=decoded.replace(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu,'');
    const visible=!stack.some(s=>s.skip),region=stack.some(s=>s.region)?'navigation':'content',linkUrl=stack.some(s=>s.atomicAnchor)?anchor?.url:undefined;
    semanticText+=decoded;if(visible)semanticVisibleText+=decoded;
    if(semanticAnchor&&visible)semanticAnchor.text+=decoded;
    if(semantic&&(semantic.visible!==visible||semantic.region!==region||semantic.linkUrl!==linkUrl))flushSemantic();
    semantic??={text:'',visible,region,...(linkUrl?{linkUrl}:{})};semantic.text+=decoded;
  };
  const boundary=(visible=true)=>{allText+=' ';semanticText+=' ';if(!visible)return;semanticVisibleText+=' ';if(norm(chunk))segments.push(norm(chunk));chunk='';text+=' ';};
  const content=(token:string)=>{const decoded=decode(token);semanticContent(decoded);allText+=decoded;if(stack.some(s=>s.skip))return;text+=decoded;chunk+=decoded;if(norm(decoded))segments.push(norm(decoded));if(anchor)anchor.text+=decoded;};
  for(let position=0;position<clean.length;){
    const start=clean.indexOf('<',position);
    if(start<0){content(clean.slice(position));break;}
    if(start>position)content(clean.slice(position,start));
    const prefix=/^<\/?([a-z][\w:-]*)(?=[\s/>])/i.exec(clean.slice(start)),declaration=clean.startsWith('<!',start)||clean.startsWith('<?',start);
    if(!prefix&&!declaration){content('<');position=start+1;continue;}
    let end=start+(prefix?.[0].length||2),quote='';
    for(;end<clean.length;end++){const char=clean[end];if(quote){if(char===quote)quote='';}else if((char==='"'||char==="'")&&clean.slice(start,end).trimEnd().endsWith('='))quote=char;else if(char==='>')break;}
    if(end===clean.length){content(clean.slice(start));break;}
    const token=clean.slice(start,end+1);position=end+1;if(declaration)continue;
    const tag=prefix![1].toLowerCase();
    if(token.startsWith('</')){
      if(blocks.has(tag)||tag==='br'||tag==='a'&&stack.some(s=>s.atomicAnchor))flushSemantic();
      if(tag==='a'&&semanticAnchor){if(norm(semanticAnchor.text))semanticFragments.push({...semanticAnchor,text:norm(semanticAnchor.text)});semanticAnchor=undefined;}
      if(blocks.has(tag))boundary(!stack.some(s=>s.skip));
      if(tag==='a'&&anchor){anchor.text=norm(anchor.text);links.push(anchor);anchor=undefined;}
      const index=stack.map(s=>s.tag).lastIndexOf(tag);if(index>=0)stack.splice(index);
      continue;
    }
    const attrs:Record<string,string>={};for(const match of token.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g))attrs[match[1].toLowerCase()]=decode(match[2]??match[3]??match[4],true);
    if(tag==='base'&&attrs.href&&!baseSeen){try{documentBase=new URL(attrs.href,base).href;baseSeen=true;}catch{}}
    const region=['nav','header','footer'].includes(tag)||/(?:^|[\s_-])(nav|navbar|menu|header|footer|topbar|bottombar|sidebar|copyright|breadcrumb)(?:[\s_-]|$)/i.test((attrs.class||'')+' '+(attrs.id||''));
    // aria-hidden affects the accessibility tree, not visual text visibility.
    const skip=['head','svg','canvas'].includes(tag)||/\shidden(?:\s|=|>)/i.test(token)||/display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs.style||'')||stack.some(s=>s.skip);
    const inert=['head','svg','canvas'].includes(tag)||stack.some(s=>s.inert),icon=/(?:^|\s)(?:iconfont|icon(?:-[\w-]+)?|fa(?:[bsrl]|-[\w-]+)?)(?:\s|$)/i.test(attrs.class||'');
    const atomicAnchor=tag==='a'&&(region||stack.some(s=>s.region)||!stack.some(s=>prose.has(s.tag)));
    if(blocks.has(tag)||tag==='br'||atomicAnchor||skip!==stack.some(s=>s.skip)||inert!==stack.some(s=>s.inert))flushSemantic();
    if(blocks.has(tag)||tag==='br')boundary(!skip);
    if((tag==='a'||tag==='area')&&attrs.href&&!skip){let href=attrs.href;try{const parsed=new URL(href,documentBase);if(parsed.username||parsed.password||!['http:','https:'].includes(parsed.protocol))throw new Error();href=parsed.href;}catch{if(!/^(?:mailto:|tel:|sms:)/i.test(href))href='';}if(href){const item={url:href,text:'',where:region||stack.some(s=>s.region)?'navigation':'content'};if(tag==='area')links.push(item);else{anchor=item;semanticAnchor={text:'',visible:true,region:item.where as 'navigation'|'content',linkUrl:href};}}}
    if(!voids.has(tag)&&!token.endsWith('/>'))stack.push({tag,region,skip,inert,icon,atomicAnchor});
  }
  boundary();
  flushSemantic();
  return {title,text:norm(text),allText:norm(allText),segments:[...new Set(segments)],semanticFragments,semanticText:norm(semanticText),semanticVisibleText:norm(semanticVisibleText),links,unsupported};
}
