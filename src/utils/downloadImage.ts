import { toPng } from 'html-to-image';
import { createGIF } from 'gifshot';

/**
 * 모바일 기기 감지
 */
function isMobile(): boolean {
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

/**
 * iOS 기기 또는 Safari(WebKit) 감지
 * html-to-image는 Safari에서 첫 렌더링 때 내부 이미지를 빠뜨리는 경우가 있어 워밍업이 필요하다.
 */
function isWebKit(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/i.test(ua) || (/Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Android/i.test(ua));
}

/**
 * 적절한 pixelRatio 계산 (모바일에서는 낮추기)
 */
function getOptimalPixelRatio(): number {
  if (isMobile()) {
    // 모바일에서는 devicePixelRatio를 그대로 사용하되 최대 2로 제한
    return Math.min(window.devicePixelRatio || 1, 2);
  }
  return 2;
}

/**
 * 복제할 CSS 속성 목록
 * 최신 WebKit은 corner-*-shape 속성이 함께 설정되면 border-radius를 `corner:` 축약형으로
 * 직렬화하는데, SVG로 다시 그릴 때 이 값이 적용되지 않아 둥근 모서리가 모두 사라진다.
 * corner-shape는 기본값(round)이면 되므로 복제 대상에서 제외한다.
 */
function getStyleProperties(): string[] {
  return Array.from(window.getComputedStyle(document.documentElement)).filter(
    (name) => !name.startsWith('corner-')
  );
}

/**
 * html-to-image 공통 옵션
 */
function getImageOptions() {
  return {
    quality: 1,
    pixelRatio: getOptimalPixelRatio(),
    cacheBust: true,
    // 외부 폰트 인라인으로 포함
    includeQueryParams: true,
    // 스타일 복사 시 계산된 스타일 사용
    skipAutoScale: true,
    includeStyleProperties: getStyleProperties(),
  };
}

/**
 * 재시도 로직이 포함된 toPng
 */
async function toPngWithRetry(
  element: HTMLElement,
  maxRetries: number = 3
): Promise<string> {
  const options = getImageOptions();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // 첫 시도 전에 약간의 대기 (리소스 로딩 보장)
      if (attempt === 0) {
        await new Promise(r => setTimeout(r, 100));
        // Safari는 첫 렌더링에서 이미지가 빠지는 경우가 있어 한 번 버리고 다시 그린다
        if (isWebKit()) {
          await toPng(element, options).catch(() => undefined);
        }
      }

      const dataUrl = await toPng(element, options);

      // 유효한 데이터인지 확인 (빈 이미지 체크)
      if (dataUrl && dataUrl.length > 1000) {
        return dataUrl;
      }

      // 너무 작은 이미지면 재시도
      lastError = new Error('생성된 이미지가 너무 작습니다');
    } catch (error) {
      lastError = error as Error;
      console.warn(`캡처 시도 ${attempt + 1} 실패:`, error);
    }

    // 재시도 전 대기 (점점 길게)
    if (attempt < maxRetries - 1) {
      await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }

  throw lastError || new Error('이미지 캡처 실패');
}

/**
 * Data URL을 Blob으로 변환
 */
function dataUrlToBlob(dataUrl: string): Blob {
  const arr = dataUrl.split(',');
  const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/png';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

/**
 * Web Share API로 공유 (모바일)
 */
async function shareImage(dataUrl: string, filename: string): Promise<boolean> {
  if (!navigator.share || !navigator.canShare) {
    return false;
  }

  try {
    const blob = dataUrlToBlob(dataUrl);
    const file = new File([blob], filename, { type: blob.type });

    if (!navigator.canShare({ files: [file] })) {
      return false;
    }

    await navigator.share({
      files: [file],
      title: 'V-Archive Tier Card',
    });
    return true;
  } catch (error) {
    // 사용자가 공유 취소한 경우
    if ((error as Error).name === 'AbortError') {
      return true;
    }
    return false;
  }
}

/**
 * 파일 다운로드
 * 큰 data URL을 그대로 href에 넣으면 모바일 브라우저에서 파일이 깨지거나 저장되지 않으므로 Blob URL을 사용한다.
 */
function downloadFile(dataUrl: string, filename: string): void {
  const url = URL.createObjectURL(dataUrlToBlob(dataUrl));
  const link = document.createElement('a');
  link.download = filename;
  link.href = url;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * 생성된 이미지 저장 (모바일은 공유 시트 우선, 실패 시 다운로드)
 * 생성이 오래 걸리면 사용자 제스처가 만료되어 공유나 window.open이 막히므로 다운로드로 대체한다.
 */
async function saveImage(dataUrl: string, filename: string): Promise<void> {
  if (isMobile() && (await shareImage(dataUrl, filename))) {
    return;
  }
  downloadFile(dataUrl, filename);
}

export async function downloadCardAsImage(
  element: HTMLElement,
  filename: string = 'tier-card.png'
): Promise<void> {
  try {
    const video = element.querySelector('video');
    let dataUrl: string;

    if (video) {
      // 비디오가 있으면 캔버스로 교체 후 캡처
      dataUrl = await captureWithVideoAsCanvas(element, video);
    } else {
      // 재시도 로직이 포함된 캡처
      dataUrl = await toPngWithRetry(element);
    }

    await saveImage(dataUrl, filename);
  } catch (error) {
    console.error('이미지 다운로드 실패:', error);
    throw error;
  }
}

/**
 * 비디오 프레임을 data URL로 변환
 */
function videoFrameToDataUrl(video: HTMLVideoElement): string {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('캔버스 컨텍스트 생성 실패');
  }

  // 비디오 실제 해상도 - 모바일에서 videoWidth가 0일 수 있음
  const videoWidth = video.videoWidth > 0 ? video.videoWidth : 340;
  const videoHeight = video.videoHeight > 0 ? video.videoHeight : 340;

  canvas.width = videoWidth;
  canvas.height = videoHeight;

  // 비디오 프레임을 캔버스에 그리기
  ctx.drawImage(video, 0, 0, videoWidth, videoHeight);

  // PNG data URL로 변환
  return canvas.toDataURL('image/png');
}

/**
 * 비디오를 img 태그로 교체한 후 캡처 (html-to-image에서 더 안정적)
 */
async function captureWithVideoAsCanvas(
  element: HTMLElement,
  video: HTMLVideoElement
): Promise<string> {
  const videoParent = video.parentElement;
  if (!videoParent) {
    throw new Error('비디오 부모 요소를 찾을 수 없습니다');
  }

  // 비디오 로드 확인
  await ensureVideoLoaded(video);

  // 비디오 프레임을 이미지 data URL로 변환
  const frameDataUrl = videoFrameToDataUrl(video);

  // img 태그 생성 (html-to-image에서 canvas보다 안정적)
  const img = document.createElement('img');
  img.src = frameDataUrl;
  img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:9999px;';

  // 이미지 로드 대기
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('이미지 로드 실패'));
    // 이미 로드된 경우
    if (img.complete) resolve();
  });

  // 비디오를 img로 교체
  videoParent.removeChild(video);
  videoParent.appendChild(img);

  // 렌더링 안정화 대기 - 모바일에서는 더 긴 대기 시간 필요
  const waitTime = isMobile() ? 300 : 150;
  await new Promise(r => setTimeout(r, waitTime));

  try {
    // 재시도 로직이 포함된 캡처
    const dataUrl = await toPngWithRetry(element);
    return dataUrl;
  } finally {
    // 비디오 복원
    videoParent.removeChild(img);
    videoParent.appendChild(video);
  }
}

/**
 * 비디오가 포함된 카드를 GIF로 다운로드 (Canvas 합성 방식)
 */
export async function downloadCardAsGif(
  element: HTMLElement,
  filename: string = 'tier-card.gif',
  options: {
    frameCount?: number;
    frameDuration?: number;
  } = {}
): Promise<void> {
  const { frameCount = 30, frameDuration = 1 } = options;

  const video = element.querySelector('video');

  if (!video) {
    return downloadCardAsImage(element, filename.replace('.gif', '.png'));
  }

  try {
    // 비디오 메타데이터 로드 대기
    await ensureVideoLoaded(video);

    // Canvas 합성 방식으로 프레임 생성
    const { frames, width, height } = await createFramesWithCanvasComposite(element, video, frameCount);

    if (frames.length === 0) {
      throw new Error('프레임을 캡처하지 못했습니다');
    }

    const gifDataUrl = await createGifFromFrames(frames, frameDuration, width, height);

    await saveImage(gifDataUrl, filename);
  } catch (error) {
    console.error('GIF 다운로드 실패:', error);
    throw error;
  }
}

/**
 * Canvas 합성 방식으로 GIF 프레임 생성
 * 배경은 한 번만 캡처하고, 비디오 프레임만 Canvas에서 합성
 */
async function createFramesWithCanvasComposite(
  element: HTMLElement,
  video: HTMLVideoElement,
  frameCount: number
): Promise<{ frames: string[]; width: number; height: number }> {
  const videoParent = video.parentElement;
  if (!videoParent) {
    throw new Error('비디오 부모 요소를 찾을 수 없습니다');
  }

  // 1. 비디오 영역의 위치와 크기 계산 (카드 기준 상대 좌표)
  const cardRect = element.getBoundingClientRect();
  const videoRect = video.getBoundingClientRect();

  const pixelRatio = getOptimalPixelRatio();

  // 2. 비디오를 투명 placeholder로 교체하고 배경 캡처
  const placeholder = document.createElement('div');
  placeholder.style.cssText = video.style.cssText;
  placeholder.style.width = '100%';
  placeholder.style.height = '100%';
  placeholder.style.backgroundColor = 'transparent';
  placeholder.style.borderRadius = '9999px';

  videoParent.removeChild(video);
  videoParent.appendChild(placeholder);

  // 렌더링 안정화 대기
  await new Promise(r => setTimeout(r, 100));

  // 배경 이미지 캡처 (비디오 영역은 비어있음)
  const backgroundDataUrl = await toPngWithRetry(element);

  // placeholder 제거, 비디오 복원
  videoParent.removeChild(placeholder);
  videoParent.appendChild(video);

  // 3. 배경 이미지 로드
  const backgroundImg = await loadImage(backgroundDataUrl);

  // 카드 내에서 비디오의 상대 위치 (실제 캡처된 배경 크기 기준으로 환산)
  const scaleX = backgroundImg.width / cardRect.width || pixelRatio;
  const scaleY = backgroundImg.height / cardRect.height || pixelRatio;
  const videoPosition = {
    x: (videoRect.left - cardRect.left) * scaleX,
    y: (videoRect.top - cardRect.top) * scaleY,
    width: videoRect.width * scaleX,
    height: videoRect.height * scaleY,
  };

  // 4. 비디오 프레임들을 캡처하고 배경과 합성
  const frames: string[] = [];
  const duration = isFinite(video.duration) && video.duration > 0 ? video.duration : 2;
  const interval = duration / frameCount;

  const wasPlaying = !video.paused;
  video.pause();

  // 비디오 크기
  const videoWidth = video.videoWidth > 0 ? video.videoWidth : 340;
  const videoHeight = video.videoHeight > 0 ? video.videoHeight : 340;

  for (let i = 0; i < frameCount; i++) {
    try {
      // 비디오 시간 설정
      video.currentTime = (i * interval) % duration;
      await waitForVideoSeek(video);

      // 합성 캔버스 생성
      const compositeCanvas = document.createElement('canvas');
      compositeCanvas.width = backgroundImg.width;
      compositeCanvas.height = backgroundImg.height;
      const ctx = compositeCanvas.getContext('2d');

      if (!ctx) continue;

      // 배경 그리기
      ctx.drawImage(backgroundImg, 0, 0);

      // 비디오 프레임을 원형으로 클리핑하여 그리기
      ctx.save();

      // 원형 클리핑 패스 생성
      const centerX = videoPosition.x + videoPosition.width / 2;
      const centerY = videoPosition.y + videoPosition.height / 2;
      const radius = Math.min(videoPosition.width, videoPosition.height) / 2;

      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip();

      // 비디오 프레임 그리기 (클리핑된 영역에만)
      ctx.drawImage(
        video,
        0, 0, videoWidth, videoHeight,  // 소스
        videoPosition.x, videoPosition.y, videoPosition.width, videoPosition.height  // 대상
      );

      ctx.restore();

      // 프레임을 data URL로 변환
      frames.push(compositeCanvas.toDataURL('image/png'));
    } catch (frameError) {
      console.warn(`프레임 ${i} 합성 실패:`, frameError);
    }
  }

  // 비디오 재생 상태 복원
  if (wasPlaying) {
    video.play().catch(() => {});
  }

  // GIF는 화면에 보이는 카드 크기(CSS px)와 같은 비율로 만든다
  return {
    frames,
    width: Math.round(cardRect.width),
    height: Math.round(cardRect.height),
  };
}

/**
 * 이미지 로드 헬퍼
 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('이미지 로드 실패'));
    img.src = src;
  });
}

/**
 * 비디오 메타데이터 로드 확인
 */
function ensureVideoLoaded(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 2 && video.duration > 0) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      reject(new Error('비디오 로드 타임아웃'));
    }, 5000);

    const onLoaded = () => {
      clearTimeout(timeout);
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
      resolve();
    };

    const onError = () => {
      clearTimeout(timeout);
      video.removeEventListener('loadeddata', onLoaded);
      video.removeEventListener('error', onError);
      reject(new Error('비디오 로드 실패'));
    };

    video.addEventListener('loadeddata', onLoaded);
    video.addEventListener('error', onError);
  });
}

/**
 * 비디오 seek 완료 대기
 */
function waitForVideoSeek(video: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };

    video.addEventListener('seeked', onSeeked);

    // 타임아웃 fallback (모바일은 seek가 느려 여유를 둔다)
    setTimeout(() => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    }, isMobile() ? 1000 : 300);
  });
}

/**
 * 이미지 프레임들로 GIF 생성
 */
function createGifFromFrames(
  frames: string[],
  frameDuration: number,
  width: number,
  height: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (frames.length === 0) {
      reject(new Error('프레임이 없습니다'));
      return;
    }

    // 크기를 고정하면 화면 폭에 따라 카드 비율이 달라지는 모바일에서 GIF가 늘어나 깨진다
    createGIF(
      {
        images: frames,
        gifWidth: width,
        gifHeight: height,
        frameDuration: frameDuration,
        interval: 0.05,
        numWorkers: 2,

      },
      (result) => {
        if (result.error) {
          reject(new Error(result.errorMsg || 'GIF 생성 실패'));
        } else if (result.image) {
          resolve(result.image);
        } else {
          reject(new Error('GIF 생성 결과가 없습니다'));
        }
      }
    );
  });
}

/**
 * 비디오가 있는지 확인
 */
export function hasVideo(element: HTMLElement): boolean {
  return element.querySelector('video') !== null;
}
