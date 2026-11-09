import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionHtml } from '../server/automation/collection/html.js';
import { collectionLinksEquivalent, missingCollectionText } from '../server/automation/collection/text-links.js';

const origin='https://target.invalid',parse=(body:string,base=origin)=>collectionHtml('<html><body>'+body+'</body></html>',base);
const missing=(source:string,target:string)=>missingCollectionText(parse(source,'https://source.invalid').semanticFragments,parse(target),value=>value.replace('https://source.invalid',origin),origin);

test('navigation regrouping, added brand labels and footer link wrappers preserve real text units',()=>{
  const source='<nav><div><a href="/a">Cinema 系列</a><a href="/b">品牌产品</a></div></nav><footer><p>电话：0592-5684388</p><div>0592-5684388 /13599919996</div></footer>';
  const target='<nav><ul><li><a href="/a">Brand · Cinema 系列</a></li><li><a href="/b">品牌产品</a></li></ul></nav><footer><p>客服热线 电话：<a href="tel:05925684388">0592-5684388</a></p><div><a href="tel:05925684388">0592-5684388</a> / <a href="tel:13599919996">13599919996</a></div><p>详情咨询 &gt;</p></footer>';
  assert.deepEqual(missing(source,target),[]);
  assert.deepEqual(missing(source,target.replace('Cinema 系列','Cinema系列')),['Cinema 系列']);
});

test('explicit iconfont private-use decoration is omitted while real private-use prose remains required',()=>{
  assert.deepEqual(missing('<nav><p>品牌与产品<span class="iconfont h-o-con-add">&#xe607;</span></p></nav>','<nav><p>品牌与产品</p></nav>'),[]);
  assert.deepEqual(missing('<p>正文符号：&#xe607;</p>','<p>正文符号：</p>'),['正文符号：\ue607']);
  assert.deepEqual(missing('<p><span class="iconfont">关键文字</span></p>','<p></p>'),['关键文字']);
});

test('changed names, sentences, numbers and wrong link labels cannot borrow matching text elsewhere',()=>{
  for(const [source,target] of [['Pro Cinema系列','ProCinema系列'],['Signature Elite系列','SignatureElite系列'],['Demand 系列音箱','Demand系列音箱'],['PI 系列','PI系列'],['1 2','12'],['<span>1</span><span>2</span>','1 2'],['12','1123'],['Sentence with all words.','Sentence all with words.']])assert.ok(missing('<p>'+source+'</p>','<p>'+target+'</p>').length,source);
  assert.ok(missing('<nav><a href="/a">Original name</a></nav>','<nav><a href="/a">Wrong name</a><a href="/other">Original name</a></nav>').length);
  assert.deepEqual(missing('<p hidden>Hidden record</p><p>Visible sentence</p>','<p>Hidden record</p><p hidden>Visible sentence</p>'),['Visible sentence']);
});

test('prose preserves inline words and navigation labels retain explicit character spacing',()=>{
  assert.deepEqual(missing('<p>One <span>complete</span> sentence.</p>','<p>One <em>complete</em> sentence.</p>'),[]);
  assert.deepEqual(missing('<nav><a href="/a">Original name</a></nav>','<p>Read <a href="/a">Original name</a> here.</p>'),[]);
  assert.ok(missing('<p>Read <a href="/a">Original name</a> here.</p>','<p>Read here.</p><p><a href="/a">Original name</a></p>').length);
  assert.deepEqual(missing('<a href="/back">[ 返 回 ]</a>','<a href="/back">[返回]</a>'),['[ 返 回 ]']);
});

test('telephone equivalence preserves number, international prefix, extension and malformed values',()=>{
  const equivalent=(left:string,right:string)=>collectionLinksEquivalent(left,right,origin);
  assert.equal(equivalent('tel:0592-5684388','tel:05925684388'),true);
  assert.equal(equivalent('tel:+1 (202) 555-0123;ext=4','tel:+12025550123;ext=4'),true);
  for(const [left,right] of [['tel:0592-5684388','tel:05925684389'],['tel:+12025550123','tel:12025550123'],['tel:2025550123;ext=1','tel:2025550123;ext=2'],['tel:2025550123','tel:2025550123;ext=1'],['tel:123/456','tel:123456'],['tel:12(34','tel:1234']])assert.equal(equivalent(left,right),false,left);
});

test('external HTTPS upgrades require the same full address and never relax internal routes',()=>{
  const same=(left:string,right:string)=>collectionLinksEquivalent(left,right,origin),url='http://maps.invalid/marker?a=1&label=%E5%9C%B0%E5%9D%80#pin';
  assert.equal(same(url,'https://maps.invalid/marker?a=1&label=地址#pin'),true);
  for(const actual of ['https://other.invalid/marker?a=1&label=地址#pin','https://maps.invalid/other?a=1&label=地址#pin','https://maps.invalid/marker?a=2&label=地址#pin','https://maps.invalid/marker?a=1&label=地址#other','https://maps.invalid:8080/marker?a=1&label=地址#pin','https://maps.invalid/marker?a=1&a=2&label=地址#pin'])assert.equal(same(url,actual),false,actual);
  assert.equal(same('https://maps.invalid/marker','http://maps.invalid/marker'),false);
  assert.equal(same('http://target.invalid/path','https://target.invalid/path'),false);
});
