const thermalStops = [[5,8,30],[30,20,115],[145,16,124],[235,54,44],[255,177,20],[255,255,220]];
const thermalPalette = new Uint8ClampedArray(256 * 3);
for (let i=0;i<256;i++) {
  const position=i/255*(thermalStops.length-1), index=Math.min(thermalStops.length-2,Math.floor(position)), mix=position-index;
  for(let c=0;c<3;c++)thermalPalette[i*3+c]=thermalStops[index][c]*(1-mix)+thermalStops[index+1][c]*mix;
}

export function boxEffectRect(track, width, height) {
  if(![track.x,track.y,track.w,track.h].every(Number.isFinite)||track.w<=0||track.h<=0)return null;
  const left=Math.max(0,Math.floor(track.x*width)),top=Math.max(0,Math.floor(track.y*height));
  const right=Math.min(width,Math.ceil((track.x+track.w)*width)),bottom=Math.min(height,Math.ceil((track.y+track.h)*height));
  return right>left&&bottom>top?{x:left,y:top,w:right-left,h:bottom-top}:null;
}

// Artistic X-ray and thermal palettes, derived from image luminance.
export function applyBoxPalette(image, options, scratch) {
  const {data,width,height}=image, count=width*height;
  let luma;
  if(options.fxXray) {
    luma=scratch?.length>=count?scratch:new Uint8ClampedArray(count);
    for(let i=0;i<count;i++){const p=i*4;luma[i]=.2126*data[p]+.7152*data[p+1]+.0722*data[p+2];}
  }
  for(let i=0;i<count;i++) {
    const p=i*4;
    let r=data[p],g=data[p+1],b=data[p+2];
    if(options.fxXray) {
      const x=i%width,y=Math.floor(i/width);
      const edge=(Math.abs(luma[y*width+Math.max(0,x-1)]-luma[y*width+Math.min(width-1,x+1)])
        +Math.abs(luma[Math.max(0,y-1)*width+x]-luma[Math.min(height-1,y+1)*width+x]))/255;
      const value=Math.min(1,(1-luma[i]/255)*.82+edge*.9);
      r=value*140;g=8+value*210;b=10+value*245;
    }
    if(options.fxThermal) {
      const index=Math.max(0,Math.min(255,Math.round(.2126*r+.7152*g+.0722*b)))*3;
      r=thermalPalette[index];g=thermalPalette[index+1];b=thermalPalette[index+2];
    }
    if(options.fxInvert){r=255-r;g=255-g;b=255-b;}
    data[p]=r;data[p+1]=g;data[p+2]=b;
  }
  return image;
}

export class BoxEffectsRenderer {
  constructor(createCanvas=()=>document.createElement('canvas')) {
    this.base=createCanvas();this.work=createCanvas();
    this.baseCtx=this.base.getContext('2d');
    this.workCtx=this.work.getContext('2d',{willReadFrequently:true});
    this.luma=new Uint8ClampedArray(256*256);
  }

  draw(ctx, tracks, options) {
    if(!options.boxEffects||!tracks.length||!['fxZoom','fxPixelate','fxXray','fxThermal','fxInvert'].some(key=>options[key]))return;
    const width=ctx.canvas.width,height=ctx.canvas.height;
    if(this.base.width!==width)this.base.width=width;
    if(this.base.height!==height)this.base.height=height;
    this.baseCtx.clearRect(0,0,width,height);
    // Every box samples the same frame. Overlapping boxes never process an already altered box.
    this.baseCtx.drawImage(ctx.canvas,0,0);
    const colorPass=options.fxXray||options.fxThermal;
    const blockSize=Math.max(3,Math.round(Math.min(width,height)/720*12));
    for(const track of tracks) {
      const rect=boxEffectRect(track,width,height);
      if(!rect)continue;
      const {x,y,w,h}=rect,zoom=options.fxZoom?2:1;
      const sx=x+w*(1-1/zoom)/2,sy=y+h*(1-1/zoom)/2,sw=w/zoom,sh=h/zoom;
      // Pixel effects have a bounded working size; zoom and invert retain full image detail.
      const downscale=options.fxPixelate?blockSize:colorPass?Math.max(1,Math.max(w,h)/256):1;
      const workWidth=Math.max(1,Math.round(w/downscale)),workHeight=Math.max(1,Math.round(h/downscale));
      if(this.work.width!==workWidth)this.work.width=workWidth;
      if(this.work.height!==workHeight)this.work.height=workHeight;
      this.workCtx.clearRect(0,0,workWidth,workHeight);
      this.workCtx.drawImage(this.base,sx,sy,sw,sh,0,0,workWidth,workHeight);
      if(colorPass) {
        const image=this.workCtx.getImageData(0,0,workWidth,workHeight);
        const count=workWidth*workHeight;
        if(this.luma.length<count)this.luma=new Uint8ClampedArray(count);
        applyBoxPalette(image,options,this.luma);
        this.workCtx.putImageData(image,0,0);
      }
      ctx.save();
      ctx.globalAlpha=1;
      ctx.filter=!colorPass&&options.fxInvert?'invert(1)':'none';
      ctx.imageSmoothingEnabled=!options.fxPixelate;
      ctx.drawImage(this.work,x,y,w,h);
      ctx.restore();
    }
  }
}
