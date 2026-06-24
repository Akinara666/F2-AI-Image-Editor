import { useRef } from 'react';
import { fabric } from 'fabric';
import { createClientId } from '../../constants';
import { UI_OVERLAY_ROLES } from '../../utils/canvasLogic';

const MAX_UNDO_STEPS = 50;

const UNDO_LAYER_PROPS = [
    'editorLayerId',
    'editorLayerName',
    'editorLayerOpacity',
    'editorLayerFillOpacity',
    'editorLayerBlendMode',
    'editorLayerLocked'
];

const UNDO_SERIALIZED_PROPS = [
    'editorRole',
    'id',
    'isMask',
    'isCandidate',
    'candidateSourceUrl',
    'assetId',
    'objectCaching',
    'noScaleCache',
    ...UNDO_LAYER_PROPS
];

const UNDO_IMAGE_PROPS = [
    'assetId',
    'editorRole',
    'isCandidate',
    'candidateSourceUrl',
    'left',
    'top',
    'width',
    'height',
    'scaleX',
    'scaleY',
    'angle',
    'flipX',
    'flipY',
    'opacity',
    'visible',
    'originX',
    'originY',
    'stroke',
    'strokeWidth',
    'strokeDashArray',
    'objectCaching',
    'noScaleCache',
    'cropX',
    'cropY',
    ...UNDO_LAYER_PROPS
];

const pickObjectProps = (object, propertyNames) => (
    propertyNames.reduce((accumulator, propertyName) => {
        const value = object[propertyName];
        accumulator[propertyName] = Array.isArray(value) ? [...value] : value;
        return accumulator;
    }, {})
);

export const useEditorUndo = () => {
    const undoAssetRegistryRef = useRef(new Map());
    const undoStackRef = useRef([]);
    const undoObjectCacheRef = useRef(new WeakMap());
    const undoFrameCacheRef = useRef(new WeakMap());
    const undoFrameVisualCacheRef = useRef(new WeakMap());

    const getUndoVersion = (object) => object?.undoVersion || 0;

    const markUndoDirty = (object) => {
        if (!object) {
            return;
        }

        object.undoVersion = getUndoVersion(object) + 1;
    };

    const serializeWithCache = (object, cacheRef, serializer) => {
        if (!object) {
            return null;
        }

        const version = getUndoVersion(object);
        const cached = cacheRef.current.get(object);
        if (cached && cached.version === version) {
            return cached.value;
        }

        const value = serializer(object);
        cacheRef.current.set(object, { version, value });
        return value;
    };

    const areObjectEntryListsEqual = (left, right) => (
        left.length === right.length && left.every((entry, index) => entry === right[index])
    );

    const areSnapshotsEquivalent = (left, right) => {
        if (!left || !right) {
            return false;
        }

        return left.frame === right.frame
            && left.frameVisual === right.frameVisual
            && areObjectEntryListsEqual(left.objects || [], right.objects || []);
    };

    const pushUndoSnapshot = (snapshot) => {
        if (!snapshot) return;

        const previousSnapshot = undoStackRef.current[undoStackRef.current.length - 1];
        if (areSnapshotsEquivalent(previousSnapshot, snapshot)) {
            return;
        }

        undoStackRef.current.push(snapshot);
        if (undoStackRef.current.length > MAX_UNDO_STEPS) {
            undoStackRef.current.splice(0, undoStackRef.current.length - MAX_UNDO_STEPS);
        }
    };

    const registerUndoAsset = (object) => {
        if (!object || object.type !== 'image') {
            return null;
        }

        const element = object.getElement?.();
        if (!element) {
            return null;
        }

        const assetId = object.assetId || createClientId('undo-asset');
        if (!object.assetId) {
            object.set({ assetId });
        }
        if (!undoAssetRegistryRef.current.has(assetId)) {
            undoAssetRegistryRef.current.set(assetId, element);
        }
        return assetId;
    };

    const serializeUndoObject = (object) => {
        return serializeWithCache(object, undoObjectCacheRef, (target) => {
            if (target.type === 'image') {
                const assetId = registerUndoAsset(target);
                if (!assetId) {
                    return {
                        kind: 'object',
                        object: target.toObject(UNDO_SERIALIZED_PROPS)
                    };
                }

                return {
                    kind: 'image',
                    assetId,
                    props: pickObjectProps(target, UNDO_IMAGE_PROPS)
                };
            }

            return {
                kind: 'object',
                object: target.toObject(UNDO_SERIALIZED_PROPS)
            };
        });
    };

    const pruneUndoAssets = (canvas) => {
        const referencedAssetIds = new Set();

        undoStackRef.current.forEach((snapshot) => {
            (snapshot?.objects || []).forEach((entry) => {
                if (entry?.kind === 'image' && entry.assetId) {
                    referencedAssetIds.add(entry.assetId);
                }
            });
        });

        canvas?.getObjects().forEach((object) => {
            const assetId = registerUndoAsset(object);
            if (assetId) {
                referencedAssetIds.add(assetId);
            }
        });

        for (const assetId of undoAssetRegistryRef.current.keys()) {
            if (!referencedAssetIds.has(assetId)) {
                undoAssetRegistryRef.current.delete(assetId);
            }
        }
    };

    const createUndoSnapshot = ({
        canvas,
        frameObject,
        frameVisualObject,
        serializeFrameState,
        serializeFrameVisualState
    }) => {
        if (!canvas || !frameObject || !frameVisualObject) {
            return null;
        }

        return {
            frame: serializeWithCache(frameObject, undoFrameCacheRef, serializeFrameState),
            frameVisual: serializeWithCache(frameVisualObject, undoFrameVisualCacheRef, serializeFrameVisualState),
            objects: canvas
                .getObjects()
                .filter((object) => (
                    object !== frameObject
                    && object !== frameVisualObject
                    && !UI_OVERLAY_ROLES.includes(object?.editorRole)
                ))
                .map(serializeUndoObject)
        };
    };

    const commitUndoSnapshot = (params) => {
        pushUndoSnapshot(createUndoSnapshot(params));
        pruneUndoAssets(params.canvas);
    };

    const popUndoSnapshot = () => {
        if (undoStackRef.current.length <= 1) {
            return null;
        }

        undoStackRef.current.pop();
        return undoStackRef.current[undoStackRef.current.length - 1] || null;
    };

    const restoreUndoSnapshot = async ({
        snapshot,
        canvas,
        frameObject,
        frameVisualObject,
        genFrameVisualRef,
        syncFrameVisualState,
        applyFrameViewportStyle,
        setGenFrame,
        setGenDimensions,
        enforceCanvasLayerOrder,
        syncCandidateFromCanvas,
        syncMaskStateFromCanvas,
        syncCanvasInteractionMode
    }) => {
        if (!snapshot || !canvas || !frameObject || !frameVisualObject) {
            return;
        }

        const enlivenedObjects = (await Promise.all((snapshot.objects || []).map(async (entry) => {
            if (entry?.kind === 'image') {
                const source = undoAssetRegistryRef.current.get(entry.assetId);
                if (!source) {
                    console.warn(`Missing undo asset: ${entry.assetId}`);
                    return null;
                }

                const image = new fabric.Image(source, entry.props || {});
                image.setCoords();
                return image;
            }

            return await new Promise((resolve) => {
                fabric.util.enlivenObjects([entry?.object], (objects) => {
                    resolve(objects[0] || null);
                });
            });
        }))).filter(Boolean);

        canvas.discardActiveObject();
        canvas.getObjects()
            .filter((object) => (
                object !== frameObject
                && object !== frameVisualObject
                && !UI_OVERLAY_ROLES.includes(object?.editorRole)
            ))
            .forEach((object) => canvas.remove(object));

        frameObject.set(snapshot.frame);
        frameObject.setCoords();
        frameVisualObject.set(snapshot.frameVisual);
        frameVisualObject.setCoords();
        markUndoDirty(frameObject);
        markUndoDirty(frameVisualObject);
        genFrameVisualRef.current = frameVisualObject;

        enlivenedObjects.forEach((object) => {
            canvas.add(object);
        });

        syncFrameVisualState(frameObject, frameVisualObject);
        applyFrameViewportStyle(frameVisualObject, canvas.getZoom());
        setGenFrame(frameObject);
        setGenDimensions({
            width: Math.round(frameObject.width * frameObject.scaleX),
            height: Math.round(frameObject.height * frameObject.scaleY)
        });
        enforceCanvasLayerOrder(canvas, frameObject);
        syncCandidateFromCanvas(canvas, frameObject);
        syncMaskStateFromCanvas(canvas);
        syncCanvasInteractionMode(canvas, frameObject);
        pruneUndoAssets(canvas);
        canvas.requestRenderAll();
    };

    return {
        createUndoSnapshot,
        commitUndoSnapshot,
        markUndoDirty,
        popUndoSnapshot,
        pushUndoSnapshot,
        restoreUndoSnapshot
    };
};
