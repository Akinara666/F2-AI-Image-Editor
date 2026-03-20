import { useRef, useState } from 'react';
import { CANVAS_DEFAULTS } from '../../constants';

export const useEditorDocumentState = ({ fabricCanvas, isCandidateObject }) => {
    const [genFrame, setGenFrame] = useState(null);
    const [candidate, setCandidate] = useState(null);
    const [candidateUrl, setCandidateUrl] = useState(null);
    const [hasMaskOverlay, setHasMaskOverlay] = useState(false);
    const [isMaskOverlayVisible, setIsMaskOverlayVisible] = useState(false);
    const [genDimensions, setGenDimensions] = useState({
        width: CANVAS_DEFAULTS.DEFAULT_WIDTH,
        height: CANVAS_DEFAULTS.DEFAULT_HEIGHT
    });

    const candidateRef = useRef(null);
    const maskOverlayVisibleRef = useRef(false);
    const genFrameVisualRef = useRef(null);

    const setCandidateState = (nextCandidate, nextUrl = null) => {
        candidateRef.current = nextCandidate;
        setCandidate(nextCandidate);
        setCandidateUrl(nextUrl);
    };

    const syncCandidateFromCanvas = (canvas, frameObject = genFrame) => {
        const nextCandidate = canvas?.getObjects().find((object) => isCandidateObject(object, frameObject)) || null;
        setCandidateState(nextCandidate, nextCandidate?.candidateSourceUrl || null);
        return nextCandidate;
    };

    const getMaskGroupFromCanvas = (canvas) => (
        canvas?.getObjects().find((object) => object.id === 'maskGroup') || null
    );

    const syncMaskStateFromCanvas = (canvas = fabricCanvas) => {
        const maskGroup = getMaskGroupFromCanvas(canvas);
        const nextHasMask = !!(maskGroup && maskGroup.getObjects().length > 0);
        const nextMaskVisible = nextHasMask ? maskGroup.visible !== false : false;

        maskOverlayVisibleRef.current = nextMaskVisible;
        setHasMaskOverlay(nextHasMask);
        setIsMaskOverlayVisible(nextMaskVisible);
        return maskGroup;
    };

    const setMaskOverlayVisibility = (visible, canvas = fabricCanvas) => {
        const maskGroup = getMaskGroupFromCanvas(canvas);
        if (!maskGroup) {
            maskOverlayVisibleRef.current = false;
            setHasMaskOverlay(false);
            setIsMaskOverlayVisible(false);
            return null;
        }

        maskGroup.set({ visible });
        canvas?.requestRenderAll();
        syncMaskStateFromCanvas(canvas);
        return maskGroup;
    };

    const syncFrameVisualState = (frameObject = genFrame, frameVisualObject = genFrameVisualRef.current) => {
        if (!frameObject || !frameVisualObject) return;

        frameVisualObject.set({
            left: frameObject.left,
            top: frameObject.top,
            width: frameObject.width,
            height: frameObject.height,
            scaleX: frameObject.scaleX,
            scaleY: frameObject.scaleY,
            angle: frameObject.angle,
            visible: frameObject.visible
        });
        frameVisualObject.setCoords();
    };

    return {
        candidate,
        candidateRef,
        candidateUrl,
        genDimensions,
        genFrame,
        genFrameVisualRef,
        hasMaskOverlay,
        isMaskOverlayVisible,
        maskOverlayVisibleRef,
        getMaskGroupFromCanvas,
        setCandidateState,
        setGenDimensions,
        setGenFrame,
        setMaskOverlayVisibility,
        syncCandidateFromCanvas,
        syncFrameVisualState,
        syncMaskStateFromCanvas
    };
};
