import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionHtml } from '../server/automation/collection/html.js';
const parse=(body:string)=>collectionHtml('<html><head><title>原站</title></head><body>'+body+'</body></html>','https://source.invalid/');

test('real legacy copyright and visible aria-hidden pagination remain source text',()=>{
  const footer=parse('<div class="footer-end">Copyright &copy 漫威智能影音 版权所有  工信备案：<a href="http://beian.miit.gov.cn">闽ICP备2021017839号</a></div>');
  assert.equal(footer.text,'Copyright © 漫威智能影音 版权所有 工信备案：闽ICP备2021017839号');assert.equal(footer.unsupported,false);
  const pages=parse('<ul><li><a href=""><span aria-hidden="true">&laquo;</span></a></li><li><a href=""><span aria-hidden="true">&raquo;</span></a></li></ul>');
  assert.equal(pages.text,'« »');assert.ok(pages.segments.includes('«'));assert.ok(pages.segments.includes('»'));assert.equal(pages.unsupported,false);
});

test('literal numeric comparisons and legacy closing br preserve real captured wording',()=>{
  assert.equal(parse('<p>总谐波失真(THD)(20Hz–20kHz) <0.03% 频率响应10Hz - 100kHz +0.5, -3dB</p>').text,'总谐波失真(THD)(20Hz–20kHz) <0.03% 频率响应10Hz - 100kHz +0.5, -3dB');
  assert.equal(parse('<p>高频单元</br>BDSS™（平衡双环绕系统）</br>线性波导技术</p>').text,'高频单元BDSS™（平衡双环绕系统）线性波导技术');
  assert.equal(parse('<p><span style="font-size:16px" font-size:16px;line-height:2.5;"="">保留原文</span></p><p>后续正文</p>').text,'保留原文 后续正文');
});

test('inline adjacency, explicit spaces and block boundaries do not merge distinct numbers',()=>{
  for(const [source,expected] of [['<p>1 2</p>','1 2'],['<p>12</p>','12'],['<p><span>1</span><span>2</span></p>','12'],['<p><span>1</span> <span>2</span></p>','1 2'],['<div>1</div><div>2</div>','1 2']])assert.equal(parse(source).text,expected);
  assert.ok(parse('<p><span>1</span><span>2</span></p>').segments.includes('12'));
});

test('quoted angle brackets, attribute entities and inert scripts retain their separate meaning',()=>{
  const result=parse('<a title="1 > 0" href="/data?a=1&amp;b=2">正确</a><script>secret body</script><p hidden>hidden</p><span style="display:none">no</span>');
  assert.equal(result.text,'正确');assert.equal(result.links[0].url,'https://source.invalid/data?a=1&b=2');assert.ok(!result.text.includes('secret'));
  assert.ok(result.allText.includes('hidden'));assert.ok(!result.allText.includes('secret'));
  assert.equal(parse('<p>&unknownWord;</p>').unsupported,true);
  assert.equal(collectionHtml('<!DOCTYPE html><html><body>正文</body></html>','https://source.invalid/').text,'正文');
});
