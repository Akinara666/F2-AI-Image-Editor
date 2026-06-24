import { fabric } from 'fabric';
import { applyAdjustment, buildLuminanceHistogram, SPATIAL_ADJUSTMENT_TYPES } from '../../utils/imageFilters';
import { sampleMaskForLayer } from './selectionEngine';
import { cloneCanvasElement, ensureWritableCanvasElement } from './rasterUtils';

// Слои крупнее этого порога предпросматриваются на даунскейле
// (только пространственные фильтры — LUT-фильтры тянут полный кадр).
const PREVIEW_PIXEL_LIMIT = 1.5e6;

const getContext = (canvasElement) => canvasElement.getContext('2d', { willReadFrequently: true });

// Сессия разрушающей коррекции: предпросмотр через подмену элемента слоя,
// commit запекает с нового элемента, cancel возвращает исходный.
// Исходный (pristine) элемент никогда не мутируется — он может быть
// зарегистрирован в реестре undo-ассетов.
export const createAdjustmentSession = ({ canvas, targetObject, selection }) => {
    if (!canvas || !targetObject) {
        return null;
    }

    if (!ensureWritableCanvasElement(targetObject)) {
        return null;
    }
    const pristineElement = targetObject.getElement();
    const width = pristineElement.width;
    const height = pristineElement.height;
    if (width < 1 || height < 1) {
        return null;
    }

    const pristineContext = getContext(pristineElement);
    if (!pristineContext) {
        return null;
    }
    const pristineImageData = pristineContext.getImageData(0, 0, width, height);

    const workCanvas = cloneCanvasElement(pristineElement);
    const workContext = getContext(workCanvas);
    targetObject.setElement(workCanvas);

    const selectionMask = selection
        ? sampleMaskForLayer(selection, targetObject, width, height)
        : null;
    const selectionMissesLayer = Boolean(selection) && !selectionMask;

    // Даунскейл-превью для пространственных фильтров на больших слоях.
    const previewScale = width * height > PREVIEW_PIXEL_LIMIT
        ? Math.sqrt(PREVIEW_PIXEL_LIMIT / (width * height))
        : 1;
    let previewSource = null;
    let previewMask = null;
    if (previewScale < 1) {
        const previewWidth = Math.max(1, Math.round(width * previewScale));
        const previewHeight = Math.max(1, Math.round(height * previewScale));
        const previewCanvas = fabric.util.createCanvasElement();
        previewCanvas.width = previewWidth;
        previewCanvas.height = previewHeight;
        const previewContext = getContext(previewCanvas);
        previewContext.drawImage(pristineElement, 0, 0, previewWidth, previewHeight);
        previewSource = previewContext.getImageData(0, 0, previewWidth, previewHeight);
        if (selection) {
            const ratioX = (targetObject.scaleX || 1) * (width / previewWidth);
            const ratioY = (targetObject.scaleY || 1) * (height / previewHeight);
            previewMask = sampleMaskForLayer(
                selection,
                {
                    left: targetObject.left,
                    top: targetObject.top,
                    scaleX: ratioX,
                    scaleY: ratioY
                },
                previewWidth,
                previewHeight
            );
        }
    }

    let rafHandle = null;
    let pendingUpdate = null;
    let isClosed = false;

    const blendWithMask = (filtered, original, mask) => {
        if (!mask) {
            return;
        }
        const { data } = filtered;
        for (let pixel = 0; pixel < mask.length; pixel += 1) {
            const coverage = mask[pixel];
            if (coverage === 255) {
                continue;
            }
            const offset = pixel * 4;
            if (coverage === 0) {
                data[offset] = original[offset];
                data[offset + 1] = original[offset + 1];
                data[offset + 2] = original[offset + 2];
                data[offset + 3] = original[offset + 3];
                continue;
            }
            const inverse = 255 - coverage;
            data[offset] = (data[offset] * coverage + original[offset] * inverse) / 255;
            data[offset + 1] = (data[offset + 1] * coverage + original[offset + 1] * inverse) / 255;
            data[offset + 2] = (data[offset + 2] * coverage + original[offset + 2] * inverse) / 255;
            data[offset + 3] = (data[offset + 3] * coverage + original[offset + 3] * inverse) / 255;
        }
    };

    const computeFullResolution = (type, params) => {
        const filtered = {
            data: new Uint8ClampedArray(pristineImageData.data),
            width,
            height
        };
        if (!selectionMissesLayer) {
            applyAdjustment(filtered, type, params);
            blendWithMask(filtered, pristineImageData.data, selectionMask);
        }
        return filtered;
    };

    const renderPreview = (type, params) => {
        const useDownscale = previewSource && SPATIAL_ADJUSTMENT_TYPES.includes(type);

        if (!useDownscale) {
            const filtered = computeFullResolution(type, params);
            workContext.putImageData(
                new ImageData(filtered.data, width, height),
                0,
                0
            );
        } else {
            const scaled = {
                data: new Uint8ClampedArray(previewSource.data),
                width: previewSource.width,
                height: previewSource.height
            };
            if (!selectionMissesLayer) {
                // Радиусы пространственных фильтров масштабируются вместе с превью.
                const scaledParams = { ...params };
                if (typeof scaledParams.radius === 'number') {
                    scaledParams.radius = Math.max(0.5, scaledParams.radius * previewScale);
                }
                applyAdjustment(scaled, type, scaledParams);
                blendWithMask(scaled, previewSource.data, previewMask);
            }
            const stagingCanvas = fabric.util.createCanvasElement();
            stagingCanvas.width = scaled.width;
            stagingCanvas.height = scaled.height;
            getContext(stagingCanvas).putImageData(
                new ImageData(scaled.data, scaled.width, scaled.height),
                0,
                0
            );
            workContext.imageSmoothingEnabled = true;
            workContext.clearRect(0, 0, width, height);
            workContext.drawImage(stagingCanvas, 0, 0, width, height);
        }

        targetObject.set({ dirty: true });
        canvas.requestRenderAll();
    };

    const update = (type, params) => {
        if (isClosed) {
            return;
        }
        pendingUpdate = { type, params };
        if (rafHandle !== null) {
            return;
        }
        rafHandle = window.requestAnimationFrame(() => {
            rafHandle = null;
            if (isClosed || !pendingUpdate) {
                return;
            }
            const { type: pendingType, params: pendingParams } = pendingUpdate;
            pendingUpdate = null;
            renderPreview(pendingType, pendingParams);
        });
    };

    const close = () => {
        isClosed = true;
        if (rafHandle !== null) {
            window.cancelAnimationFrame(rafHandle);
            rafHandle = null;
        }
    };

    const commit = (type, params) => {
        if (isClosed) {
            return false;
        }
        const filtered = computeFullResolution(type, params);
        const finalCanvas = fabric.util.createCanvasElement();
        finalCanvas.width = width;
        finalCanvas.height = height;
        getContext(finalCanvas).putImageData(new ImageData(filtered.data, width, height), 0, 0);

        targetObject.setElement(finalCanvas);
        // Новый asset id: старые undo-снапшоты продолжают указывать на
        // pristine-элемент, иначе мутация портит историю.
        targetObject.set({ assetId: null, dirty: true });
        close();
        canvas.requestRenderAll();
        return true;
    };

    const cancel = () => {
        if (isClosed) {
            return;
        }
        targetObject.setElement(pristineElement);
        targetObject.set({ dirty: true });
        close();
        canvas.requestRenderAll();
    };

    return {
        targetObject,
        selectionMissesLayer,
        update,
        commit,
        cancel,
        getHistogram: () => buildLuminanceHistogram({
            data: pristineImageData.data,
            width,
            height
        })
    };
};
