import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import Sidebar from './Sidebar';

vi.mock('axios');

const createBaseProps = (overrides = {}) => ({
  availableModels: [
    { id: 'model-alpha', label: 'Model Alpha' },
    { id: 'model-beta', label: 'Model Beta' }
  ],
  params: {
    model_id: 'model-alpha',
    sampler: 'Euler a',
    frame_size_index: 0,
    prompt: 'cinematic cat portrait',
    negative_prompt: 'low quality',
    seed: -1,
    steps: 20,
    cfg: 7.5,
    denoising_strength: 0.75,
    mask_blur: 4,
    mask_padding: 32
  },
  setParams: vi.fn(),
  isGenerating: false,
  isBusy: false,
  generationStatus: 'idle',
  onGenerate: vi.fn(),
  onCancel: vi.fn(),
  brushMode: 'none',
  setBrushMode: vi.fn(),
  brushColor: '#ffffff',
  setBrushColor: vi.fn(),
  brushSize: 12,
  setBrushSize: vi.fn(),
  onQuickSelectionCopy: vi.fn(),
  onQuickSelectionPaste: vi.fn(),
  onQuickSelectionRefine: vi.fn(),
  layers: [],
  onLayerSelect: vi.fn(),
  onLayerAdd: vi.fn(),
  onLayerToggleVisibility: vi.fn(),
  onLayerToggleLock: vi.fn(),
  onLayerStyleChange: vi.fn(),
  onUndo: vi.fn(),
  onClear: vi.fn(),
  editorRef: { current: { setGenFrameSize: vi.fn() } },
  showToastError: vi.fn(),
  showToastSuccess: vi.fn(),
  showToastInfo: vi.fn(),
  ...overrides
});

const SidebarHarness = ({ initialParams, ...overrides }) => {
  const [params, setParams] = React.useState(initialParams);
  return (
    <Sidebar
      {...createBaseProps({
        ...overrides,
        params,
        setParams
      })}
    />
  );
};

describe('Sidebar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ограничивает количество шагов при вводе значения выше максимума', () => {
    const setParams = vi.fn();
    const { container } = render(<Sidebar {...createBaseProps({ setParams })} />);

    const stepsInput = container.querySelector('input[name="steps"]');
    expect(stepsInput).not.toBeNull();
    fireEvent.change(stepsInput, { target: { value: '999' } });

    expect(setParams).toHaveBeenCalled();
    const updater = setParams.mock.calls.at(-1)[0];
    const nextState = updater(createBaseProps().params);
    expect(nextState.steps).toBe(150);
  });

  it('при blur возвращает невалидный сид к последнему корректному значению', () => {
    const { container } = render(<SidebarHarness initialParams={createBaseProps().params} />);

    const seedInput = container.querySelector('input[name="seed"]');
    expect(seedInput).not.toBeNull();
    fireEvent.change(seedInput, { target: { value: '12.5' } });
    expect(seedInput).toHaveValue(12.5);

    fireEvent.blur(seedInput);
    expect(seedInput).toHaveValue(-1);
  });

  it('передаёт новый размер рамки в editorRef при смене пресета', () => {
    const setGenFrameSize = vi.fn();
    const { container } = render(
      <Sidebar
        {...createBaseProps({
          editorRef: { current: { setGenFrameSize } }
        })}
      />
    );

    const frameSizeSelect = container.querySelector('select[name="frame_size_index"]');
    expect(frameSizeSelect).not.toBeNull();
    fireEvent.change(frameSizeSelect, {
      target: { value: '2' }
    });

    expect(setGenFrameSize).toHaveBeenCalledWith(512, 768);
  });

  it('успешно обновляет промпт и негативный промпт через AI-transform', async () => {
    axios.post.mockResolvedValue({
      data: {
        status: 'success',
        data: {
          transformed_prompt: 'enhanced cinematic cat portrait',
          transformed_negative_prompt: 'bad anatomy, blurry',
          transform_status: 'success',
          provider: 'stub',
          latency_ms: 42
        }
      }
    });

    const showToastSuccess = vi.fn();
    const showToastInfo = vi.fn();
    render(
      <SidebarHarness
        initialParams={createBaseProps().params}
        showToastSuccess={showToastSuccess}
        showToastInfo={showToastInfo}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Улучшить промпт с AI' }));

    await waitFor(() => {
      expect(screen.getByDisplayValue('enhanced cinematic cat portrait')).toBeInTheDocument();
      expect(screen.getByDisplayValue('bad anatomy, blurry')).toBeInTheDocument();
    });

    expect(showToastSuccess).toHaveBeenCalledWith('Промпт успешно улучшен.');
    expect(showToastInfo).toHaveBeenCalledWith('Трансформер: stub (42 мс)');
  });

  it('показывает toast-ошибку при неудачном AI-transform', async () => {
    axios.post.mockRejectedValue({
      response: {
        data: {
          detail: 'service unavailable'
        }
      }
    });

    const showToastError = vi.fn();
    render(
      <SidebarHarness
        initialParams={createBaseProps().params}
        showToastError={showToastError}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Улучшить промпт с AI' }));

    await waitFor(() => {
      expect(showToastError).toHaveBeenCalledWith('Ошибка улучшения промпта: service unavailable');
    });
  });
});
