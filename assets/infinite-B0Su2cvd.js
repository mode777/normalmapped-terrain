import{m as ze,I as We,v as O,w as V,e as Ue,f as Z,F as Q,D as de,x as xe,N as I,y as G,r as Te,U as _e,z as Oe,a as le,W as Ne,A as He,g as Re,h as Ie,i as ne,j as b,V as he,o as Ge,s as Ke,p as Be,l as R,q as Ye,H as qe,E as ge,L as K,G as B,J as Xe,K as $e,O as je,b as j}from"./shaders-D9furo4h.js";const be=20260217,ke=1500;function Ve(a=be){const{heightAt:e}=ze({seed:a,warpWavelength:5900,warpAmplitude:1600,continentWavelength:45e3,erosionWavelength:14300,mountainWavelength:5900,mountainOctaves:7,spineWavelength:6e3,spineAnisotropy:2.4,hillsWavelength:3850,hillsOctaves:4,roughnessWavelength:3e3,mountainAmp:.74,hillsAmp:.15,detailLayers:[{wavelength:714,amplitude:.03,octaves:3},{wavelength:154,amplitude:.018,octaves:3},{wavelength:40,amplitude:.01,octaves:2},{wavelength:17,amplitude:.004,octaves:2}]});return{seed:a,heightAt:e,heightScale:ke}}class Le{constructor(){this.positions=[],this.skirt=[],this.indices=[],this.map=new Map}vertex(e,t){const i=`${e},${t}`;let s=this.map.get(i);return s===void 0&&(s=this.positions.length/3,this.positions.push(e,0,t),this.skirt.push(0),this.map.set(i,s)),s}raw(e,t,i){const s=this.positions.length/3;return this.positions.push(e,0,t),this.skirt.push(i),s}tri(e,t,i){this.indices.push(e,t,i)}}function Ae(a){const e=new Ue;return e.setAttribute("position",new Z(new Float32Array(a.positions),3)),e.setAttribute("aSkirt",new Z(new Float32Array(a.skirt),1)),e.setIndex(new Z(new Uint32Array(a.indices),1)),e}function Pe(a,e,t,i){const s=new We;s.index=a.index;for(const h of Object.keys(a.attributes))s.setAttribute(h,a.attributes[h]);s.setAttribute("aLevel",new O(new Float32Array(e),1)),s.setAttribute("aOuter",new O(new Float32Array(t),1)),s.setAttribute("aTrim",new O(new Float32Array(i),1));const r=new O(new Float32Array(e.length*2),2),n=new O(new Float32Array(e.length*2),2),o=new O(new Float32Array(e.length*2),2);return r.setUsage(V),n.setUsage(V),o.setUsage(V),s.setAttribute("aOrigin",r),s.setAttribute("aParentOrigin",n),s.setAttribute("aCoarseOrigin",o),s.instanceCount=e.length,s}function Ze(a){const e=a,t=new Le;for(let i=-e;i<=e;i++)for(let s=-e;s<=e;s++)t.vertex(s,i);for(let i=-e;i<e;i++)for(let s=-e;s<e;s++){const r=t.vertex(s,i),n=t.vertex(s+1,i),o=t.vertex(s,i+1),h=t.vertex(s+1,i+1);t.tri(r,o,n),t.tri(n,o,h)}return Pe(Ae(t),[0],[0],[0])}function Qe(a){const e=[];for(let t=-a;t<=a;t++)e.push([t,-a]);for(let t=-a+1;t<=a;t++)e.push([a,t]);for(let t=a-1;t>=-a;t--)e.push([t,a]);for(let t=a-1;t>=-a+1;t--)e.push([-a,t]);return e}function Je(a,e){const t=a,i=e,s=2*t,r=new Le;for(let o=-s;o<s;o++)for(let h=-s;h<s;h++){if(h>=-i&&h<i&&o>=-i&&o<i)continue;const m=r.vertex(h,o),u=r.vertex(h+1,o),d=r.vertex(h,o+1),p=r.vertex(h+1,o+1);r.tri(m,d,u),r.tri(u,d,p)}const n=Qe(s);for(let o=0;o<n.length;o++){const[h,m]=n[o],[u,d]=n[(o+1)%n.length],p=r.raw(h,m,0),f=r.raw(u,d,0),y=r.raw(h,m,1),C=r.raw(u,d,1);r.tri(p,f,y),r.tri(f,C,y),r.tri(p,y,f),r.tri(f,y,C)}return Ae(r)}function pe(a,e,{hole:t=a-1,trim:i=1,outerLevel:s=-1}={}){const r=Je(a,t),n=e.map(o=>o===s?1:0);return Pe(r,e,n,e.map(()=>i))}function et(a,e,t,i,s){const r=s??new Float64Array(i*2);for(let n=0;n<i;n++){const o=t*2**n;r[n*2]=Math.round(a/o)*o,r[n*2+1]=Math.round(e/o)*o}return r}const Y=(a,e)=>(a%e+e)%e;class tt{constructor({renderer:e,seed:t,baseSpacing:i,tileSize:s,cacheTiles:r,levels:n,heightScale:o,heightTexture:h,normalTexture:m,heightType:u,normalScale:d=1,onProgress:p,onTile:f}){this.renderer=e,this.seed=t,this.baseSpacing=i,this.tileSize=s,this.normalScale=d,this.normalTileSize=s*d,this.cacheTiles=r,this.heightScale=o,this.heightTexture=h,this.normalTexture=m,this.heightType=u,this.onProgress=p,this.onTile=f,this.levels=Array.from({length:n},(C,L)=>{const A=i*Math.pow(2,L),F=s*A;return{level:L,spacing:A,tileWorld:F,cacheWorld:r*F,slots:new Array(r*r).fill(null),desired:new Array(r*r).fill(null),lastCamTx:null,lastCamTy:null}}),this.queue=[],this.jobs=new Map,this.requested=new Set,this.jobId=0,this.workers=[],this.readyWorkers=0,this.workerCount=Math.max(1,Math.min(2,(navigator.hardwareConcurrency||4)-1)),this.generated=0,this.uploaded=0,this._prime=null,this._waitDesired=null,this._glLogCount=0,this.lastUploadError=null,this.uploadErrorCount=0;const y=u===Q?new Float32Array(s*s):new Uint16Array(s*s);this.heightScratch=new de(y,s,s,xe,u),this.heightScratch.minFilter=I,this.heightScratch.magFilter=I,this.heightScratch.wrapS=G,this.heightScratch.wrapT=G,this.heightScratch.generateMipmaps=!1,this.heightScratch.flipY=!1,this.heightScratch.unpackAlignment=1,this.normalScratch=new de(new Uint8Array(this.normalTileSize*this.normalTileSize*4),this.normalTileSize,this.normalTileSize,Te,_e),this.normalScratch.minFilter=I,this.normalScratch.magFilter=I,this.normalScratch.wrapS=G,this.normalScratch.wrapT=G,this.normalScratch.generateMipmaps=!1,this.normalScratch.flipY=!1,this.normalScratch.unpackAlignment=1;for(let C=0;C<this.workerCount;C++){const L=new Worker(new URL(""+new URL("terrain-worker-ClDYXjlr.js",import.meta.url).href,import.meta.url),{type:"module"}),A={worker:L,ready:!1,inFlight:0};L.onmessage=F=>this._onWorkerMessage(F.data,A),L.onerror=F=>{console.error("Terrain worker error:",F.message||F)},L.postMessage({type:"init",seed:t}),this.workers.push(A)}}_key(e,t,i){return`${e}/${t}/${i}`}_slot(e,t){return Y(e,this.cacheTiles)+Y(t,this.cacheTiles)*this.cacheTiles}_isDesired(e,t,i){const s=this.levels[e],r=this._slot(t,i),n=s.desired[r];return n!==null&&n.tx===t&&n.ty===i}_jobPriority(e,t,i,s){return Math.max(Math.abs(e-i),Math.abs(t-s))}update(e,t,{force:i=!1}={}){let s=!1;for(const r of this.levels){const n=Math.floor(e/r.tileWorld),o=Math.floor(t/r.tileWorld);if(!i&&n===r.lastCamTx&&o===r.lastCamTy)continue;r.lastCamTx=n,r.lastCamTy=o,s=!0,r.desired.fill(null);const h=Math.floor(this.cacheTiles/2);for(let m=-h;m<-h+this.cacheTiles;m++)for(let u=-h;u<-h+this.cacheTiles;u++){const d=n+u,p=o+m,f=this._slot(d,p),y=this._key(r.level,d,p),C=this._jobPriority(d,p,n,o);if(r.desired[f]={tx:d,ty:p,key:y,priority:C},r.slots[f]!==y){if(!this.requested.has(y))this.requested.add(y),this.queue.push({key:y,level:r.level,tx:d,ty:p,priority:C});else for(const L of this.queue)if(L.key===y){L.priority=C;break}}}}s&&(this.queue=this.queue.filter(r=>this._isDesired(r.level,r.tx,r.ty)?!0:(this.requested.delete(r.key),!1)),this.queue.sort((r,n)=>r.priority-n.priority),this._pump(),this._checkPrime(),this._checkWaitDesired())}_pump(){if(this.readyWorkers!==0)for(;this.queue.length>0;){const e=this.workers.find(s=>s.ready&&s.inFlight===0);if(!e)break;const t=this.queue.shift();if(!this._isDesired(t.level,t.tx,t.ty)){this.requested.delete(t.key);continue}const i=++this.jobId;e.inFlight++,this.jobs.set(i,t),e.worker.postMessage({type:"tile",id:i,level:t.level,tx:t.tx,ty:t.ty,tileSize:this.tileSize,baseSpacing:this.baseSpacing,heightScale:this.heightScale,normalScale:this.normalScale})}}_onWorkerMessage(e,t){if(e.type==="ready"){t.ready||(t.ready=!0,this.readyWorkers++),this._pump(),this._checkPrime(),this._checkWaitDesired();return}if(e.type==="error"){console.error("Terrain tile generation failed:",e.message);const s=this.jobs.get(e.id);s&&(this.jobs.delete(e.id),t.inFlight=Math.max(0,t.inFlight-1),this.requested.delete(s.key)),this._pump();return}if(e.type!=="tile")return;const i=this.jobs.get(e.id);if(i){if(this.jobs.delete(e.id),t.inFlight=Math.max(0,t.inFlight-1),this.requested.delete(i.key),this.generated++,this._isDesired(i.level,i.tx,i.ty)){this._uploadTile(i.level,i.tx,i.ty,e.heights,e.normals),this.uploaded++;const s=this.levels[i.level];s.slots[this._slot(i.tx,i.ty)]=i.key,this.onTile?.(i)}this._pump(),this._checkPrime(),this._checkWaitDesired()}}_rawUpload(e,t,i,s,r,n,o,h,m){const u=this.renderer.getContext(),d=this.renderer.properties.get(e);!d.__webglTexture&&(this.renderer.initTexture(e),!d.__webglTexture)||(u.bindTexture(u.TEXTURE_2D_ARRAY,d.__webglTexture),u.pixelStorei(u.UNPACK_ALIGNMENT,1),u.pixelStorei(u.UNPACK_FLIP_Y_WEBGL,!1),u.pixelStorei(u.UNPACK_PREMULTIPLY_ALPHA_WEBGL,!1),u.pixelStorei(u.UNPACK_ROW_LENGTH,0),u.pixelStorei(u.UNPACK_IMAGE_HEIGHT,0),u.pixelStorei(u.UNPACK_SKIP_PIXELS,0),u.pixelStorei(u.UNPACK_SKIP_ROWS,0),u.pixelStorei(u.UNPACK_SKIP_IMAGES,0),u.texSubImage3D(u.TEXTURE_2D_ARRAY,0,t,i,s,r,n,1,o,h,m),u.bindTexture(u.TEXTURE_2D_ARRAY,null),this.renderer.resetState())}_uploadTile(e,t,i,s,r){const n=this.tileSize,o=new Float32Array(s),h=new Uint8Array(r),m=Y(t,this.cacheTiles),u=Y(i,this.cacheTiles),d={x:m*n,y:u*n,z:e},p={x:m*this.normalTileSize,y:u*this.normalTileSize,z:e};if(this.heightType===Q)this.heightScratch.image.data.set(o);else{const L=this.heightScratch.image.data;for(let A=0;A<o.length;A++)L[A]=Oe.toHalfFloat(o[A])}this.normalScratch.image.data.set(h);const f=this.renderer.getContext();f.getError(),this._rawUpload(this.heightTexture,d.x,d.y,d.z,n,n,f.RED,this.heightType===Q?f.FLOAT:f.HALF_FLOAT,this.heightScratch.image.data);const y=f.getError();this._rawUpload(this.normalTexture,p.x,p.y,p.z,this.normalTileSize,this.normalTileSize,f.RGBA,f.UNSIGNED_BYTE,this.normalScratch.image.data);const C=f.getError();y||C?(this.uploadErrorCount++,this.lastUploadError={heightErr:y,normalErr:C,heightType:this.heightType,level:e,tx:t,ty:i,heightDst:d,normalDst:p},this._glLogCount<4&&(this._glLogCount++,console.warn("tile upload GL error",JSON.stringify(this.lastUploadError)))):this.lastUploadError=null}_allDesiredLoaded(){for(const e of this.levels)for(const t of e.desired)if(t!==null&&e.slots[this._slot(t.tx,t.ty)]!==t.key)return!1;return!0}_allVisibleLoaded(){for(const e of this.levels)for(const t of e.desired)if(!(t===null||t.priority>1)&&e.slots[this._slot(t.tx,t.ty)]!==t.key)return!1;return!0}_progress(e=!1){let t=0,i=0;for(const s of this.levels)for(const r of s.desired)r===null||e&&r.priority>1||(i++,s.slots[this._slot(r.tx,r.ty)]===r.key&&t++);return{done:t,total:i}}_notifyProgress(){if(!this.onProgress)return;const e=this._progress(!0);this.onProgress(e.total>0?e.done/e.total:1,e)}_checkPrime(){if(this._prime&&(this._notifyProgress(),this._allVisibleLoaded())){const e=this._prime;this._prime=null,e()}}_checkWaitDesired(){if(this._waitDesired&&this._allDesiredLoaded()){const e=this._waitDesired;this._waitDesired=null,e()}}prime(e,t){return this.update(e,t,{force:!0}),this._allVisibleLoaded()?Promise.resolve():new Promise(i=>{this._prime=i,this._checkPrime()})}waitForDesired(e,t){return this.update(e,t,{force:!0}),this._allDesiredLoaded()?Promise.resolve():new Promise(i=>{this._waitDesired=i,this._checkWaitDesired()})}getStats(){let e=0;for(const t of this.levels)for(const i of t.slots)i!==null&&e++;return{resident:e,generated:this.generated,uploaded:this.uploaded,uploadErrors:this.uploadErrorCount,queued:this.queue.length,inFlight:this.workers.reduce((t,i)=>t+i.inFlight,0),workers:this.workerCount}}dispose(){for(const e of this.workers)e.worker.terminate()}}const Me=`
  uniform sampler2DArray uHeightArray;
  uniform float uHeightScale;
  uniform vec2 uRenderOrigin;
  uniform float uBaseSpacing;
  uniform float uTileCells;
  uniform float uCacheTiles;
  uniform float uSkirtDepth;
  uniform float uLevels;
  uniform float uCenterCells;
  uniform float uMorphCells;

  attribute float aLevel;
  attribute float aOuter;
  attribute float aTrim;
  attribute float aSkirt;
  attribute vec2 aOrigin;
  attribute vec2 aParentOrigin;
  attribute vec2 aCoarseOrigin;

  varying vec3 vWorldPos;
  varying float vHeightN;
  varying float vSkirt;
  varying float vEdge;
  flat varying float vLevel;
  flat varying float vTrim;
  flat varying vec2 vParentOrigin;

  // Toroidal tile-cache UV for a render-space position, including the
  // half-texel offset so a vertex exactly on a sample reads the texel centre.
  vec2 cacheUv(vec2 local, float spacing, float tileCells) {
    float tileWorld = uTileCells * spacing;
    vec2 phase = mod(uRenderOrigin, uCacheTiles * tileWorld) / tileWorld;
    vec2 t = phase + local / tileWorld;
    vec2 slot = mod(floor(t), uCacheTiles);
    return (slot + fract(t) + 0.5 / tileCells) / uCacheTiles;
  }

  // Height of the next-coarser *mesh* at a world position.
  //
  // A plain bilinear fetch of the coarse layer does not match the coarse
  // triangles: with per-level snapping the fine edge usually falls in the
  // middle of a coarse cell, where bilinear and the two-triangle
  // interpolation disagree by up to the LOD error. At a grazing angle that
  // mismatch opens a sliver at the ring boundary. Reproducing the coarse
  // triangulation here makes the morphed fine edge coincide with it exactly.
  float coarseMeshHeight(vec2 local, vec2 origin, float coarseSpacing, float coarseLevel) {
    vec2 g = (local - origin) / coarseSpacing;
    vec2 cell = floor(g);
    vec2 f = g - cell;

    float h00 = texture(uHeightArray, vec3(cacheUv(origin + cell * coarseSpacing, coarseSpacing, uTileCells), coarseLevel)).r;
    float h10 = texture(uHeightArray, vec3(cacheUv(origin + (cell + vec2(1.0, 0.0)) * coarseSpacing, coarseSpacing, uTileCells), coarseLevel)).r;
    float h01 = texture(uHeightArray, vec3(cacheUv(origin + (cell + vec2(0.0, 1.0)) * coarseSpacing, coarseSpacing, uTileCells), coarseLevel)).r;
    float h11 = texture(uHeightArray, vec3(cacheUv(origin + (cell + vec2(1.0, 1.0)) * coarseSpacing, coarseSpacing, uTileCells), coarseLevel)).r;

    // Same diagonal as buildRingGeometry: (i+1,j)-(i,j+1).
    if (f.x + f.y <= 1.0) {
      return h00 + f.x * (h10 - h00) + f.y * (h01 - h00);
    }
    return h11 + (1.0 - f.x) * (h01 - h11) + (1.0 - f.y) * (h10 - h11);
  }

  void main() {
    float spacing = uBaseSpacing * exp2(aLevel);

    // Render-space position. Absolute world = uRenderOrigin + local.
    vec2 local = aOrigin + position.xz * spacing;

    // Distance from the ring's origin in cells (0 at the centre, 2C at the
    // outer boundary).
    float edge = max(abs(position.x), abs(position.z));

    // Morph band: the outer cells of the ring blend into the next-coarser
    // level. The last ring has no coarser level.
    float morph = 0.0;
    if (aLevel < uLevels - 1.0) {
      morph = smoothstep(
        uCenterCells * 2.0 - max(uMorphCells, 1.0),
        uCenterCells * 2.0,
        edge
      );
    }

    float hN = texture(uHeightArray, vec3(cacheUv(local, spacing, uTileCells), aLevel)).r;
    if (morph > 0.0) {
      float hc = coarseMeshHeight(local, aCoarseOrigin, spacing * 2.0, aLevel + 1.0);
      hN = mix(hN, hc, morph);
    }

    float h = hN * uHeightScale;
    vec3 wp = vec3(local.x, h, local.y);
    // Collapsed for non-last rings (aOuter = 0).
    wp.y -= uSkirtDepth * aSkirt * aOuter;

    vWorldPos = wp;
    vHeightN = hN;
    vSkirt = aSkirt;
    vEdge = edge;
    vLevel = aLevel;
    vTrim = aTrim;
    vParentOrigin = aParentOrigin;

    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`,it=`
  // tonemapping_pars_fragment / colorspace_pars_fragment are auto-injected
  // by three.js; do not include the *_pars chunks again.

  uniform sampler2DArray uNormalArray;
  uniform vec2 uRenderOrigin;
  uniform float uBaseSpacing;
  uniform float uTileCells;
  uniform float uNormalTileCells;
  uniform float uCacheTiles;
  uniform float uLevels;
  uniform float uCenterCells;
  uniform float uMorphCells;
  uniform float uPixelScale;

  uniform float uNormalStrength;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform vec3 uSkyColor;
  uniform vec3 uGroundColor;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uSnowStart;
  uniform float uGrassStrength;
  uniform float uSandStrength;
  uniform float uSpecular;
  uniform float uDebugLod;
  uniform float uDebugTiles;

  varying vec3 vWorldPos;
  varying float vHeightN;
  varying float vSkirt;
  varying float vEdge;
  flat varying float vLevel;
  flat varying float vTrim;
  flat varying vec2 vParentOrigin;

  vec2 cacheUv(vec2 local, float spacing, float tileCells) {
    float tileWorld = uTileCells * spacing;
    vec2 phase = mod(uRenderOrigin, uCacheTiles * tileWorld) / tileWorld;
    vec2 t = phase + local / tileWorld;
    vec2 slot = mod(floor(t), uCacheTiles);
    return (slot + fract(t) + 0.5 / tileCells) / uCacheTiles;
  }

  void main() {
    // Clip each ring to the outer square of the level inside it. Rings above
    // level 0 are built one cell wider than their nominal boundary, so the
    // clip turns that overlap into an exact boundary without stitch geometry.
    //
    // The cut is pulled inside by a slack: discard is per fragment while MSAA
    // coverage is per sample, so cutting exactly on the shared edge loses the
    // samples that fall outside the fine ring's triangles. The slack covers
    // sub-cell misalignment and grows with the pixel footprint, keeping the
    // sliver a few pixels wide where the boundary is nearly edge-on.
    if (vTrim > 0.5) {
      float spacing = uBaseSpacing * exp2(vLevel);
      float halfSize = uCenterCells * spacing;
      vec2 d = abs(vWorldPos.xz - vParentOrigin);

      float footprint = length(vWorldPos - cameraPosition) * uPixelScale;
      float slack = min(0.125 * spacing + 4.0 * footprint, 0.75 * spacing);
      if (max(d.x, d.y) < halfSize - slack) discard;
    }

    float spacing = uBaseSpacing * exp2(vLevel);
    vec2 uvNormal = cacheUv(vWorldPos.xz, spacing, uNormalTileCells);

    if (uDebugTiles > 0.5) {
      float tw = uTileCells * spacing;
      vec2 tt = floor(mod(uRenderOrigin, uCacheTiles * tw) / tw + vWorldPos.xz / tw);
      float checker = mod(tt.x + tt.y, 2.0);
      vec3 col = mix(vec3(0.08, 0.12, 0.22), vec3(0.85, 0.65, 0.18), checker);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    // ---- normal map, with a narrow cross-fade to the next LOD that matches
    //      the vertex morph band ------------------------------------------
    vec3 nm = texture(uNormalArray, vec3(uvNormal, vLevel)).xyz * 2.0 - 1.0;

    float blend = smoothstep(
      uCenterCells * 2.0 - max(uMorphCells, 1.0),
      uCenterCells * 2.0,
      vEdge
    );

    if (vLevel < uLevels - 1.0) {
      float spacing2 = spacing * 2.0;
      vec2 uv2 = cacheUv(vWorldPos.xz, spacing2, uNormalTileCells);
      vec3 nm2 = texture(uNormalArray, vec3(uv2, vLevel + 1.0)).xyz * 2.0 - 1.0;
      nm = mix(nm, nm2, blend);
    }

    vec2 tangent = nm.xy * uNormalStrength;
    vec3 N = normalize(vec3(tangent.x, nm.z, tangent.y));

    // ---- debug LOD view ------------------------------------------------
    if (uDebugLod > 0.5) {
      float t = vLevel / max(uLevels - 1.0, 1.0);
      vec3 c = 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67)));
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      return;
    }

    // ---- lighting ------------------------------------------------------
    float ndl = max(dot(N, uSunDirection), 0.0);
    vec3 hemi = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5);

    // ---- albedo: height + slope bands ----------------------------------
    float hv = vHeightN;
    float slope = 1.0 - N.y;
    float hn = hv;

    vec3 grass = mix(vec3(0.035, 0.075, 0.025), vec3(0.120, 0.200, 0.055), hv);
    vec3 rock  = mix(vec3(0.200, 0.160, 0.120), vec3(0.400, 0.320, 0.250), hv);
    vec3 sand  = vec3(0.520, 0.430, 0.300);
    vec3 snow  = vec3(0.870, 0.900, 0.960);

    float grassW = (1.0 - smoothstep(0.28, 0.50, hn)) * uGrassStrength;
    float sandW  = (1.0 - smoothstep(0.04, 0.16, hn)) * uSandStrength;
    float snowW  = smoothstep(uSnowStart, uSnowStart + 0.14, hn + hv * 0.08);
    float steep  = smoothstep(0.42, 0.72, slope);

    // Rock is the base material. The original PoC started from grass*grassW,
    // which goes black once the grass band fades out on high ground; with an
    // infinite world that would leave whole massifs unlit.
    vec3 albedo = rock;
    albedo = mix(albedo, grass, grassW * (1.0 - steep * 0.65));
    albedo = mix(albedo, sand, sandW * (1.0 - steep));
    albedo = mix(albedo, snow, snowW * (1.0 - steep));

    float slopeShade = mix(1.0, 0.86, smoothstep(0.55, 0.90, slope));
    vec3 color = albedo * (uSunColor * ndl * 1.9 + hemi * 0.34) * slopeShade;

    // ---- specular ------------------------------------------------------
    vec3 V = normalize(cameraPosition - vWorldPos);
    vec3 H = normalize(uSunDirection + V);
    float specW = snowW * 0.9 + sandW * 0.35 + 0.02;
    color += uSunColor * pow(max(dot(N, H), 0.0), 46.0) * uSpecular * specW;

    // ---- distance fog ---------------------------------------------------
    float dist = length(vWorldPos - cameraPosition);
    float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
    color = mix(color, uFogColor, fog);

    // The horizon skirt fades into the fog so the last ring has no hard edge.
    color = mix(color, uFogColor, clamp(vSkirt, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`,st=Me,rt=`
  uniform float uLevels;
  uniform float uBaseSpacing;
  uniform float uCenterCells;
  uniform float uPixelScale;

  varying vec3 vWorldPos;
  flat varying float vLevel;
  flat varying float vTrim;
  flat varying vec2 vParentOrigin;

  void main() {
    // Match the shaded pass: hide each ring's surplus inside the parent square.
    if (vTrim > 0.5) {
      float spacing = uBaseSpacing * exp2(vLevel);
      float halfSize = uCenterCells * spacing;
      vec2 d = abs(vWorldPos.xz - vParentOrigin);
      float footprint = length(vWorldPos - cameraPosition) * uPixelScale;
      float slack = min(0.125 * spacing + 4.0 * footprint, 0.75 * spacing);
      if (max(d.x, d.y) < halfSize - slack) discard;
    }

    float t = vLevel / max(uLevels - 1.0, 1.0);
    vec3 c = 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67)));
    gl_FragColor = vec4(c, 0.9);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`,q=(a,e,t)=>Math.max(e,Math.min(t,a));class nt{constructor({camera:e,canvas:t,heightAt:i,heightScale:s,initialSpeed:r=80}){this.camera=e,this.canvas=t,this.heightAt=i,this.heightScale=s,this.x=0,this.z=0,this.y=900,this.yaw=.35,this.pitch=-.08,this.speed=r,this.autoCruise=!0,this.cruiseTime=0,this.paused=!1,this.pointerLocked=!1,this.keys=new Set,this.dragging=!1,this.lastPointerX=0,this.lastPointerY=0,this._onKeyDown=n=>this._handleKey(n,!0),this._onKeyUp=n=>this._handleKey(n,!1),this._onMouseMove=n=>this._handleMouseMove(n),this._onPointerDown=n=>this._handlePointerDown(n),this._onPointerMove=n=>this._handlePointerMove(n),this._onPointerUp=n=>this._handlePointerUp(n),this._onPointerLockChange=()=>{this.pointerLocked=document.pointerLockElement===this.canvas,this.pointerLocked&&(this.autoCruise=!1,this.onAutoCruiseChange?.(!1)),this.onPointerLockChange?.(this.pointerLocked)},this._onWheel=n=>{if(n.target!==this.canvas)return;n.preventDefault();const o=Math.exp(-n.deltaY*.0012);this.speed=q(this.speed*o,15,500),this.onSpeedChange?.(this.speed)},window.addEventListener("keydown",this._onKeyDown),window.addEventListener("keyup",this._onKeyUp),window.addEventListener("mousemove",this._onMouseMove),document.addEventListener("pointerlockchange",this._onPointerLockChange),t.addEventListener("pointerdown",this._onPointerDown),window.addEventListener("pointermove",this._onPointerMove),window.addEventListener("pointerup",this._onPointerUp),t.addEventListener("wheel",this._onWheel,{passive:!1}),this.onAutoCruiseChange=null,this.onPointerLockChange=null,this.onSpeedChange=null,this.onUserInput=null,this.reset()}_handleKey(e,t){const i=e.target&&e.target.tagName;if(i==="INPUT"||i==="SELECT"||i==="TEXTAREA"||i==="BUTTON")return;const s=e.code;["KeyW","KeyA","KeyS","KeyD","KeyQ","KeyE","ShiftLeft","ShiftRight"].includes(s)&&(t?(this.keys.add(s),this.pointerLocked||this._takeControl()):this.keys.delete(s),e.preventDefault())}_handleMouseMove(e){this.pointerLocked&&(this.yaw-=e.movementX*.0022,this.pitch-=e.movementY*.0022,this.pitch=q(this.pitch,-1.45,1.45))}_handlePointerDown(e){e.pointerType==="mouse"&&!this.pointerLocked&&document.pointerLockElement!==this.canvas&&(this.canvas.requestPointerLock?.(),this._takeControl()),(e.pointerType!=="mouse"||!this.pointerLocked)&&(this.dragging=!0,this.lastPointerX=e.clientX,this.lastPointerY=e.clientY,this.canvas.setPointerCapture?.(e.pointerId))}_handlePointerMove(e){if(!this.dragging||this.pointerLocked)return;const t=e.clientX-this.lastPointerX,i=e.clientY-this.lastPointerY;this.lastPointerX=e.clientX,this.lastPointerY=e.clientY,this.yaw-=t*.0035,this.pitch=q(this.pitch-i*.0035,-1.45,1.45),this._takeControl(!1)}_handlePointerUp(e){this.dragging=!1,this.canvas.releasePointerCapture?.(e.pointerId)}_takeControl(e=!0){e&&this.autoCruise&&(this.autoCruise=!1,this.onAutoCruiseChange?.(!1)),this.onUserInput?.()}setAutoCruise(e){this.autoCruise=e,e&&(this.cruiseTime=0,this.onAutoCruiseChange?.(!0))}setSpeed(e){this.speed=q(e,15,500),this.onSpeedChange?.(this.speed)}setPaused(e){this.paused=e}groundHeight(){return this.heightAt(this.x,this.z)*this.heightScale}reset(){this.x=0,this.z=0,this.yaw=.35,this.pitch=-.08,this.y=this.groundHeight()+220,this.cruiseTime=0}warpTo(e,t,i=null){this.x=e,this.z=t,this.y=i===null?this.groundHeight()+220:i,this.cruiseTime=0}update(e){if(this.paused)return;const t=this.groundHeight(),i=this.keys.has("ShiftLeft")||this.keys.has("ShiftRight")?3.5:1;if(this.autoCruise){this.cruiseTime+=e;const r=.3+Math.sin(this.cruiseTime*.035)*.55;this.yaw+=(r-this.yaw)*Math.min(1,e*.35),this.pitch+=(-.1-this.pitch)*Math.min(1,e*.6);const n=-Math.sin(this.yaw),o=-Math.cos(this.yaw),h=70*(this.speed/80);this.x+=n*h*e,this.z+=o*h*e;const m=t+180;this.y+=(m-this.y)*Math.min(1,e*.7)}else{const r=Math.cos(this.pitch),n=-Math.sin(this.yaw)*r,o=Math.sin(this.pitch),h=-Math.cos(this.yaw)*r,m=Math.cos(this.yaw),u=-Math.sin(this.yaw);let d=0,p=0,f=0;this.keys.has("KeyW")&&(d+=n,p+=o,f+=h),this.keys.has("KeyS")&&(d-=n,p-=o,f-=h),this.keys.has("KeyD")&&(d+=m,f+=u),this.keys.has("KeyA")&&(d-=m,f-=u),this.keys.has("KeyE")&&(p+=1),this.keys.has("KeyQ")&&(p-=1);const y=Math.hypot(d,p,f);if(y>0){const C=this.speed*i*e/y;this.x+=d*C,this.z+=f*C,this.y+=p*C}}const s=t+18;this.y<s&&(this.y=s),this.y>9e3&&(this.y=9e3)}applyCamera(e,t){e.position.set(this.x-t.x,this.y,this.z-t.y),e.rotation.set(this.pitch,this.yaw,0,"YXZ")}getInfo(){return{x:this.x,z:this.z,y:this.y,speed:this.speed,altitude:this.y-this.groundHeight(),autoCruise:this.autoCruise,yaw:this.yaw,pitch:this.pitch}}dispose(){window.removeEventListener("keydown",this._onKeyDown),window.removeEventListener("keyup",this._onKeyUp),window.removeEventListener("mousemove",this._onMouseMove),document.removeEventListener("pointerlockchange",this._onPointerLockChange),this.canvas.removeEventListener("pointerdown",this._onPointerDown),window.removeEventListener("pointermove",this._onPointerMove),window.removeEventListener("pointerup",this._onPointerUp),this.canvas.removeEventListener("wheel",this._onWheel)}}const g=a=>document.getElementById(a);function at(a){const e={loading:g("loading"),progressBar:g("progress-bar"),loadingStatus:g("loading-status"),titleCard:g("title-card"),stats:g("stats"),panel:g("panel"),footnote:g("footnote"),statFps:g("stat-fps"),statTris:g("stat-tris"),statCalls:g("stat-calls"),statAlt:g("stat-alt"),statSpeed:g("stat-speed"),statTiles:g("stat-tiles"),statQueue:g("stat-queue"),statPos:g("stat-pos"),sunAz:g("sun-azimuth"),sunEl:g("sun-elevation"),sunAzVal:g("sun-azimuth-val"),sunElVal:g("sun-elevation-val"),normalStrength:g("normal-strength"),normalStrengthVal:g("normal-strength-val"),wireframe:g("wireframe"),lodDebug:g("lod-debug"),tileDebug:g("tile-debug"),autoCruise:g("auto-cruise"),cruiseSpeed:g("cruise-speed"),cruiseSpeedVal:g("cruise-speed-val"),resetFlight:g("reset-flight"),panelToggle:g("panel-toggle"),flightHint:g("flight-hint"),pointerHint:g("pointer-hint"),tileStatus:g("tile-status")},t=()=>{e.sunAzVal.textContent=`${e.sunAz.value}°`,e.sunElVal.textContent=`${e.sunEl.value}°`,a.onSunChange(+e.sunAz.value,+e.sunEl.value)};e.sunAz.addEventListener("input",t),e.sunEl.addEventListener("input",t),e.normalStrength.addEventListener("input",()=>{e.normalStrengthVal.textContent=`${(+e.normalStrength.value).toFixed(2)}×`,a.onNormalStrength(+e.normalStrength.value)}),e.cruiseSpeed.addEventListener("input",()=>{e.cruiseSpeedVal.textContent=`${e.cruiseSpeed.value} m/s`,a.onSpeedChange(+e.cruiseSpeed.value)}),e.wireframe.addEventListener("change",()=>a.onWireframe(e.wireframe.checked)),e.lodDebug.addEventListener("change",()=>a.onLodDebug(e.lodDebug.checked)),e.tileDebug.addEventListener("change",()=>a.onTileDebug(e.tileDebug.checked)),e.autoCruise.addEventListener("change",()=>a.onAutoCruise(e.autoCruise.checked)),e.resetFlight.addEventListener("click",()=>a.onReset()),e.panelToggle.addEventListener("click",()=>{const n=e.panel.classList.toggle("collapsed");e.panelToggle.textContent=n?"+":"–"}),window.matchMedia&&window.matchMedia("(max-width: 760px)").matches&&(e.panel.classList.add("collapsed"),e.panelToggle.textContent="+");const i=document.createElement("div");i.className="glass chip",i.id="toast",i.style.cssText="position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:50;padding:9px 16px;font-size:.78rem;color:var(--text-dim);display:none;",document.body.appendChild(i);let s=null;function r(n,o=!1){i.textContent=n,i.style.display="block",clearTimeout(s),o||(s=setTimeout(()=>{i.style.display="none"},1800))}return{setLoading(n,o){e.progressBar.style.width=`${Math.round(n*100)}%`,o&&(e.loadingStatus.textContent=o)},hideLoading(){e.loading.classList.add("done"),setTimeout(()=>e.loading.remove(),700);for(const n of[e.titleCard,e.stats,e.panel,e.footnote])n?.classList.remove("hidden");e.flightHint?.classList.remove("hidden")},setStats({fps:n,tris:o,calls:h,alt:m,speed:u,tiles:d,queue:p,pos:f}){e.statFps.textContent=n,e.statTris.textContent=o,e.statCalls.textContent=h,e.statAlt.textContent=m,e.statSpeed.textContent=u,e.statTiles.textContent=d,e.statQueue.textContent=p,e.statPos.textContent=f},setAutoCruise(n){e.autoCruise.checked=n},setSpeed(n){e.cruiseSpeed.value=Math.round(n),e.cruiseSpeedVal.textContent=`${Math.round(n)} m/s`},setPointerLock(n){e.pointerHint?.classList.toggle("hidden",n),n&&e.flightHint?.classList.add("hidden")},setTileStatus(n){e.tileStatus&&(e.tileStatus.textContent=n)},toast:r}}const l={seed:be,baseSpacing:2,centerCells:24,levels:10,tileSize:64,normalScale:8,cacheTiles:4,heightScale:ke,skirtDepth:420,morphCells:3},ae=2*l.centerCells*l.baseSpacing*Math.pow(2,l.levels-1),U=l.cacheTiles*l.tileSize,N=U*l.normalScale,J=2048;if(U>J||N>J)throw new Error(`tile cache ${U}/${N} exceeds ${J} texels`);const ot=2.4/ae,fe=l.cacheTiles*l.tileSize*l.baseSpacing*Math.pow(2,l.levels-1),X=l.baseSpacing*Math.pow(2,l.levels+1),w={sunAz:305,sunEl:34,normalStrength:1,wireframe:!1,lodDebug:!1,autoCruise:!0},k=new le(0,0),M=new Float64Array(l.levels*2);let x,H,P,z,W,S,me,E,ee,te,ie,Ee,ve,c,D,v,_,T,oe,we=performance.now(),se=0,re=performance.now();const $=()=>new Promise(a=>requestAnimationFrame(()=>setTimeout(a,0))),lt=a=>a>=1e6?`${(a/1e6).toFixed(1)}M`:a>=1e3?`${Math.round(a/1e3)}k`:String(a),ye=(a,e)=>(a%e+e)%e,Se=new le;function De(){return x.getDrawingBufferSize(Se),2*Math.tan(j.degToRad(P.fov)/2)/Math.max(1,Se.y)}async function ht(){const e=new URLSearchParams(location.search).get("cruise")!=="0";v=at({onSunChange:(t,i)=>{w.sunAz=t,w.sunEl=i,Ce()},onNormalStrength:t=>{w.normalStrength=t,S&&(S.uniforms.uNormalStrength.value=t)},onWireframe:t=>{w.wireframe=t,E&&(E.visible=t)},onLodDebug:t=>{w.lodDebug=t,S&&(S.uniforms.uDebugLod.value=t?1:0)},onTileDebug:t=>{S&&(S.uniforms.uDebugTiles.value=t?1:0)},onAutoCruise:t=>{w.autoCruise=t,c?.setAutoCruise(t)},onSpeedChange:t=>{c?.setSpeed(t)},onReset:()=>pt()}),v.setLoading(.02,"Creating renderer…"),await $(),ut(),ve=Ve(l.seed),c=new nt({camera:P,canvas:x.domElement,heightAt:ve.heightAt,heightScale:l.heightScale,initialSpeed:80}),c.autoCruise=e,c.onAutoCruiseChange=t=>{w.autoCruise=t,v.setAutoCruise(t)},c.onSpeedChange=t=>v.setSpeed(t),c.onPointerLockChange=t=>v.setPointerLock(t),w.autoCruise=e,v.setAutoCruise(e),v.setSpeed(c.speed),v.setLoading(.06,"Creating texture arrays…"),await $(),ct(),v.setLoading(.1,"Starting terrain worker…"),D=new tt({renderer:x,seed:l.seed,baseSpacing:l.baseSpacing,tileSize:l.tileSize,cacheTiles:l.cacheTiles,levels:l.levels,heightScale:l.heightScale,heightTexture:_,normalTexture:T,heightType:oe,normalScale:l.normalScale,onProgress:(t,i)=>{v.setLoading(.12+t*.72,`Generating terrain tiles… ${i.done}/${i.total}`)}}),v.setLoading(.12,"Generating terrain tiles…"),await D.prime(c.x,c.z),v.setLoading(.88,"Building clipmap…"),await $(),dt(),Ce(),v.setLoading(1,"Ready"),await $(),v.hideLoading(),v.setPointerLock(!1),mt(),Fe()}function ut(){const a=document.getElementById("scene");x=new Ne({canvas:a,antialias:!0,powerPreference:"high-performance"}),x.setPixelRatio(Math.min(window.devicePixelRatio||1,2)),x.setSize(window.innerWidth,window.innerHeight,!1),x.toneMapping=He,x.toneMappingExposure=1,x.setClearColor(724756,1),H=new Re,P=new Ie(60,window.innerWidth/window.innerHeight,2,ae*1.5),P.rotation.order="YXZ",W=new ne({vertexShader:Be,fragmentShader:Ke,side:Ge,depthWrite:!1,uniforms:{uZenith:{value:new b(.2,.42,.72)},uHorizon:{value:new b(.68,.78,.88)},uSunDirection:{value:new he(0,1,0)},uSunColor:{value:new b(1,.97,.9)}}}),z=new R(new Ye(1,48,32),W),z.name="sky",z.scale.setScalar(ae*1.3),z.frustumCulled=!1,H.add(z),window.addEventListener("resize",ft)}function ct(){oe=qe;const a=new Uint16Array(U*U*l.levels);_=new ge(a,U,U,l.levels),_.format=xe,_.type=oe,_.minFilter=K,_.magFilter=K,_.wrapS=B,_.wrapT=B,_.generateMipmaps=!1,_.flipY=!1,_.unpackAlignment=1,_.needsUpdate=!0,x.initTexture(_);const e=new Uint8Array(N*N*l.levels*4);T=new ge(e,N,N,l.levels),T.format=Te,T.type=_e,T.minFilter=K,T.magFilter=K,T.wrapS=B,T.wrapT=B,T.generateMipmaps=!1,T.flipY=!1,T.unpackAlignment=1,T.anisotropy=Math.min(4,x.capabilities.getMaxAnisotropy()),T.needsUpdate=!0,x.initTexture(T),_.image.data=null,T.image.data=null}function dt(){const a={uHeightArray:{value:_},uNormalArray:{value:T},uHeightScale:{value:l.heightScale},uRenderOrigin:{value:new le(0,0)},uBaseSpacing:{value:l.baseSpacing},uTileCells:{value:l.tileSize},uNormalTileCells:{value:l.tileSize*l.normalScale},uCacheTiles:{value:l.cacheTiles},uSkirtDepth:{value:l.skirtDepth},uLevels:{value:l.levels},uCenterCells:{value:l.centerCells},uMorphCells:{value:l.morphCells},uPixelScale:{value:De()},uNormalStrength:{value:w.normalStrength},uSunDirection:{value:new he(0,1,0)},uSunColor:{value:new b(1,.97,.9)},uSkyColor:{value:new b(.2,.42,.72)},uGroundColor:{value:new b(.24,.23,.21)},uFogColor:{value:new b(.68,.78,.88)},uFogDensity:{value:ot},uSnowStart:{value:.62},uGrassStrength:{value:.9},uSandStrength:{value:.35},uSpecular:{value:.08},uDebugLod:{value:w.lodDebug?1:0},uDebugTiles:{value:0}};S=new ne({vertexShader:Me,fragmentShader:it,uniforms:a,side:Xe}),me=new ne({vertexShader:st,fragmentShader:rt,uniforms:S.uniforms,wireframe:!0,transparent:!0,depthWrite:!1,depthTest:!0,side:$e,polygonOffset:!0,polygonOffsetFactor:-1,polygonOffsetUnits:-2});const e=Ze(l.centerCells),t=pe(l.centerCells,[0],{hole:l.centerCells,trim:0}),i=Array.from({length:l.levels-1},(r,n)=>n+1),s=pe(l.centerCells,i,{outerLevel:l.levels-1});ee=new R(e,S),te=new R(t,S),ie=new R(s,S),ee.name="terrain-center",te.name="terrain-ring-0",ie.name="terrain-rings";for(const r of[ee,te,ie])r.frustumCulled=!1,H.add(r);Ee=[{geo:e,levels:[0]},{geo:t,levels:[0]},{geo:s,levels:i}],E=new je,E.name="debug-group";for(const[r,n]of[[e,"center"],[t,"ring-0"],[s,"rings"]]){const o=new R(r,me);o.frustumCulled=!1,o.name=`debug-${n}`,E.add(o)}E.visible=w.wireframe,H.add(E)}function Ce(){if(!S||!W)return;const a=j.degToRad(w.sunAz),e=j.degToRad(w.sunEl),t=new he(Math.sin(a)*Math.cos(e),Math.sin(e),-Math.cos(a)*Math.cos(e)).normalize(),i=j.smoothstep(w.sunEl,10,42),s=new b(1,.5,.22).lerp(new b(1,.98,.92),i),r=new b(.06,.24,.7).lerp(new b(.085,.11,.24),1-i),n=new b(.52,.72,.94).lerp(new b(.98,.5,.24),1-i),o=new b(.14,.1,.075).lerp(new b(.26,.25,.23),i),h=S.uniforms;h.uSunDirection.value.copy(t),h.uSunColor.value.copy(s),h.uSkyColor.value.copy(r),h.uGroundColor.value.copy(o),h.uFogColor.value.copy(n),W.uniforms.uSunDirection.value.copy(t),W.uniforms.uSunColor.value.copy(s),W.uniforms.uZenith.value.copy(r),W.uniforms.uHorizon.value.copy(n)}function gt(){(Math.abs(c.x-k.x)>15e3||Math.abs(c.z-k.y)>15e3)&&ue()}function ue(){k.set(Math.round(c.x/X)*X,Math.round(c.z/X)*X)}function ce(){if(c.applyCamera(P,k),et(c.x,c.z,l.baseSpacing,l.levels,M),!!S){S.uniforms.uRenderOrigin.value.set(ye(k.x,fe),ye(k.y,fe));for(const{geo:a,levels:e}of Ee){const t=a.getAttribute("aOrigin"),i=a.getAttribute("aParentOrigin"),s=a.getAttribute("aCoarseOrigin");for(let r=0;r<e.length;r++){const n=e[r];t.setXY(r,M[n*2]-k.x,M[n*2+1]-k.y);const o=Math.max(0,n-1);i.setXY(r,M[o*2]-k.x,M[o*2+1]-k.y);const h=Math.min(n+1,l.levels-1);s.setXY(r,M[h*2]-k.x,M[h*2+1]-k.y)}t.needsUpdate=!0,i.needsUpdate=!0,s.needsUpdate=!0}}}function pt(){c.reset(),ue(),c.setAutoCruise(w.autoCruise),ce(),v.toast("Position reset")}function ft(){P.aspect=window.innerWidth/window.innerHeight,P.updateProjectionMatrix(),x.setSize(window.innerWidth,window.innerHeight,!1),S&&(S.uniforms.uPixelScale.value=De())}function Fe(){requestAnimationFrame(Fe);const a=performance.now(),e=Math.min(.05,(a-we)/1e3);if(we=a,c.update(e),gt(),ce(),D.update(c.x,c.z),z.position.copy(P.position),x.render(H,P),se++,a-re>500){const t=Math.round(se*1e3/(a-re));se=0,re=a;const i=x.info.render,s=D.getStats(),r=c.getInfo();v.setStats({fps:t,tris:lt(i.triangles),calls:i.calls,alt:`${Math.round(r.altitude)}m`,speed:Math.round(r.speed),tiles:s.resident,queue:s.queued+s.inFlight,pos:`${(r.x/1e3).toFixed(1)},${(r.z/1e3).toFixed(1)}km`}),v.setTileStatus(`tiles: ${s.resident} resident · ${s.generated} generated · ${s.queued+s.inFlight} queued`)}}function mt(){const a={config:l,renderer:x,scene:H,camera:P,flight:c,streamer:D,get state(){return{...w,renderOrigin:k.toArray()}},setPaused:e=>c.setPaused(e),setAutoCruise:e=>{w.autoCruise=e,c.setAutoCruise(e),v.setAutoCruise(e)},setLodDebug:e=>{w.lodDebug=e,S.uniforms.uDebugLod.value=e?1:0,document.getElementById("lod-debug").checked=e},setTileDebug:e=>{S.uniforms.uDebugTiles.value=e?1:0,document.getElementById("tile-debug").checked=e},setWireframe:e=>{w.wireframe=e,E.visible=e,document.getElementById("wireframe").checked=e},setCrackDebug:e=>{x.setClearColor(e?16711935:724756,1),z.visible=!e},waitForTiles:()=>D.waitForDesired(c.x,c.z),warpTo:async(e,t,i=null)=>{c.setPaused(!0),w.autoCruise=!1,c.setAutoCruise(!1),v.setAutoCruise(!1),c.warpTo(e,t,i),ue(),ce(),D.update(c.x,c.z,{force:!0}),await D.waitForDesired(c.x,c.z)},groundHeight:()=>c.groundHeight(),getLevelOrigins:()=>({x:c.x,z:c.z,origins:Array.from(M)})};window.__infinite=a,new URLSearchParams(location.search).get("debug")==="1"&&(a.setLodDebug(!0),a.setWireframe(!0))}ht().catch(a=>{console.error(a);const e=document.getElementById("loading-status");e&&(e.textContent=`Failed to start: ${a.message}`,e.style.color="#ff7d7d")});
