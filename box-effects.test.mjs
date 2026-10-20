import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {applyBoxPalette,boxEffectRect,BoxEffectsRenderer} from './dist/box-effects.mjs';

function rgba(values) {return {width:values.length,height:1,data:new Uint8ClampedArray(values.flat())};}

test('box effects clip tracked regions to the frame and skip invalid or invisible boxes',()=>{
  assert.deepEqual(boxEffectRect({x:-.25,y:.2,w:.5,h:1},100,50),{x:0,y:10,w:25,h:40});
  for(const rect of [{x:2,y:0,w:.1,h:.1},{x:0,y:0,w:0,h:1},{x:NaN,y:0,w:1,h:1}])assert.equal(boxEffectRect(rect,100,50),null);
});

test('invert produces a color negative and preserves alpha',()=>{
  const image=rgba([[20,70,130,173],[0,255,100,255]]);
  applyBoxPalette(image,{fxInvert:true});
  assert.deepEqual([...image.data],[235,185,125,173,255,0,155,255]);
});

test('thermal maps dark regions to cool colors and bright regions to warm colors',()=>{
  const image=rgba([[0,0,0,255],[255,255,255,173]]);
  applyBoxPalette(image,{fxThermal:true});
  assert.ok(image.data[2]>image.data[0]);
  assert.ok(image.data[4]>image.data[6]);
  assert.equal(image.data[7],173);
});

test('X-ray creates a cool negative and selected palettes can be combined with invert',()=>{
  const original=[[0,0,0,120],[0,0,0,140],[255,255,255,200],[255,255,255,255]];
  const xray=applyBoxPalette(rgba(original),{fxXray:true});
  assert.ok(xray.data[1]>xray.data[13]);
  assert.ok(xray.data[2]>xray.data[0]);
  const positive=applyBoxPalette(rgba(original),{fxXray:true,fxThermal:true});
  const negative=applyBoxPalette(rgba(original),{fxXray:true,fxThermal:true,fxInvert:true});
  for(let i=0;i<positive.data.length;i++)assert.equal(negative.data[i],i%4===3?positive.data[i]:255-positive.data[i]);
});

test('canvas effects stay inside boxes, avoid double inversion on overlap, zoom and pixelate correctly',{
  skip:!process.env.BLOB_TRACKER_TEST_CANVAS
},()=>{
  const {createCanvas}=createRequire(import.meta.url)(process.env.BLOB_TRACKER_TEST_CANVAS);
  const canvas=createCanvas(64,48),ctx=canvas.getContext('2d');
  const renderer=new BoxEffectsRenderer(()=>createCanvas(1,1));
  const pixel=(x,y)=>[...ctx.getImageData(x,y,1,1).data];
  const fill=()=>{ctx.fillStyle='rgb(20,40,80)';ctx.fillRect(0,0,64,48);};
  const track={x:.25,y:.25,w:.5,h:.5};
  fill();renderer.draw(ctx,[track],{boxEffects:false,fxInvert:true});assert.deepEqual(pixel(25,20),[20,40,80,255]);
  renderer.draw(ctx,[track,{x:.4,y:.25,w:.5,h:.5}],{boxEffects:true,fxInvert:true});
  assert.deepEqual(pixel(30,20),[235,215,175,255]);assert.deepEqual(pixel(0,0),[20,40,80,255]);
  for(const key of ['fxXray','fxThermal']){
    fill();renderer.draw(ctx,[track],{boxEffects:true,[key]:true});
    assert.notDeepEqual(pixel(25,20),[20,40,80,255]);assert.deepEqual(pixel(0,0),[20,40,80,255]);
  }
  for(let x=0;x<64;x++){ctx.fillStyle=`rgb(${x*3},50,80)`;ctx.fillRect(x,0,1,48);}
  const before=pixel(16,20)[0];renderer.draw(ctx,[track],{boxEffects:true,fxZoom:true});assert.ok(pixel(16,20)[0]>before+10);
  for(let y=0;y<48;y++)for(let x=0;x<64;x++){ctx.fillStyle=(x+y)%2?'white':'black';ctx.fillRect(x,y,1,1);}
  renderer.draw(ctx,[track],{boxEffects:true,fxPixelate:true});
  let changes=0;for(let x=17;x<47;x++)if(pixel(x,20)[0]!==pixel(x-1,20)[0])changes++;
  assert.ok(changes<20,'pixelation groups neighboring pixels into blocks');
  const base=pixel(0,0);
  ctx.globalAlpha=.6;ctx.filter='grayscale(1)';ctx.imageSmoothingEnabled=false;
  renderer.draw(ctx,[track],{boxEffects:true,fxThermal:true,fxZoom:true,fxInvert:true,fxPixelate:true});
  assert.equal(ctx.globalAlpha,.6);assert.equal(ctx.filter,'grayscale(1)');assert.equal(ctx.imageSmoothingEnabled,false);assert.deepEqual(pixel(0,0),base);
});
