import type { CollectionTextFragment } from './html.js';

const norm=(value:string)=>value.normalize('NFC').replace(/[\s\u00a0\u3000]+/g,' ').trim();
function telephone(value:string){
  if(!/^tel:/i.test(value))return;
  const [number,...parameters]=value.slice(4).split(';');
  if(!/^\+?[0-9().\s-]+$/.test(number)||!/[0-9]/.test(number)||/\([^()]*\(/.test(number))return;
  let depth=0;for(const char of number){if(char==='(')depth++;if(char===')'&&--depth<0)return;}if(depth)return;
  return number.replace(/[().\s-]/g,'')+';'+parameters.join(';');
}

/** Conservative address equivalence; routing, query values and telephone identity stay significant. */
export function collectionLinksEquivalent(expected:string,actual:string,targetOrigin:string){
  if(expected===actual)return true;
  const leftPhone=telephone(expected),rightPhone=telephone(actual);
  if(leftPhone!==undefined||rightPhone!==undefined)return leftPhone!==undefined&&leftPhone===rightPhone;
  try{
    const left=new URL(expected),right=new URL(actual);
    return left.protocol==='http:'&&right.protocol==='https:'&&left.origin!==targetOrigin&&right.origin!==targetOrigin
      &&left.username===''&&right.username===''&&left.password===''&&right.password===''
      &&left.hostname===right.hostname&&left.port===right.port&&left.pathname===right.pathname&&left.hash===right.hash
      &&JSON.stringify([...left.searchParams])===JSON.stringify([...right.searchParams]);
  }catch{return false;}
}

function containsText(actual:string,expected:string){
  let offset=0;
  while((offset=actual.indexOf(expected,offset))!==-1){
    const before=actual[offset-1]||'',after=actual[offset+expected.length]||'';
    if(!(/[a-z0-9]/i.test(expected[0]||'')&&/[a-z0-9]/i.test(before))&&!(/[a-z0-9]/i.test(expected.at(-1)||'')&&/[a-z0-9]/i.test(after)))return true;
    offset++;
  }
  return false;
}
function contactText(value:string){
  return norm(value).replace(/(电话|手机|热线)([：:])\s*(?=[+\d])/g,'$1$2').replace(/(?<=\d)\s*\/\s*(?=\d)/g,'/');
}

/** Compare original semantic units, retaining inline prose, visibility and atomic link labels. */
export function missingCollectionText(source:CollectionTextFragment[],target:{semanticFragments:CollectionTextFragment[];semanticText:string;semanticVisibleText:string},mapLink:(url:string)=>string,targetOrigin:string){
  const missing:string[]=[];
  const candidates=target.semanticFragments.map(fragment=>({...fragment,normalizedText:norm(fragment.text),contactText:contactText(fragment.text)}));
  const linked=new Map<string,typeof candidates>();
  for(const candidate of candidates)if(candidate.linkUrl){const group=linked.get(candidate.linkUrl)||[];group.push(candidate);linked.set(candidate.linkUrl,group);}
  const allText={plain:norm(target.semanticText),contact:contactText(target.semanticText)};
  const visibleText={plain:norm(target.semanticVisibleText),contact:contactText(target.semanticVisibleText)};
  for(const fragment of source){
    const text=norm(fragment.text);if(!text)continue;
    // Only complete contact fields receive punctuation spacing normalization.
    const contact=/^(?:(?:电话|手机|热线)[：:]\s*)?[+\d\s()./-]+$/.test(text)&&(text.match(/\d/g)?.length||0)>=7;
    const normalize=contact?contactText:norm,expected=normalize(text);
    const expectedLink=fragment.linkUrl?mapLink(fragment.linkUrl):undefined;
    let matchingLinks=expectedLink!==undefined?(linked.get(expectedLink)||[]):[];
    if(expectedLink!==undefined){
      let mayHaveEquivalent=/^tel:/i.test(expectedLink);
      try{const parsed=new URL(expectedLink);mayHaveEquivalent||=parsed.protocol==='http:'&&parsed.origin!==targetOrigin;}catch{}
      if(mayHaveEquivalent)matchingLinks=[...matchingLinks,...candidates.filter(candidate=>!!candidate.linkUrl&&candidate.linkUrl!==expectedLink&&collectionLinksEquivalent(expectedLink,candidate.linkUrl,targetOrigin))];
    }
    const found=fragment.linkUrl?matchingLinks.some(candidate=>(!fragment.visible||candidate.visible)
      &&containsText(contact?candidate.contactText:candidate.normalizedText,expected))
      :candidates.some(candidate=>(!fragment.visible||candidate.visible)&&containsText(contact?candidate.contactText:candidate.normalizedText,expected))
        ||containsText((fragment.visible?visibleText:allText)[contact?'contact':'plain'],expected);
    if(!found)missing.push(fragment.text);
  }
  return [...new Set(missing)];
}
