import { execSync } from 'child_process';
import os from 'os';

/**
 * GPU detection result interface
 */
export interface IGpuDetectionResult {
  /** GPU type: 'cuda', 'vulkan', or 'cpu' */
  gpuType: 'cuda' | 'vulkan' | 'cpu';
  /** Number of GPU layers that can fit in VRAM (auto-calculated) */
  gpuLayers: number | 'auto';
  /** Total VRAM in MB (0 if no GPU) */
  vramMB: number;
  /** GPU device name (if detected) */
  deviceName: string;
}

/**
 * Detect NVIDIA GPU using nvidia-smi
 */
function detectNvidiaGpu(): { detected: boolean; vramMB: number; deviceName: string } {
  try {
    if (os.platform() === 'linux') {
      const output = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits', {
        encoding: 'utf-8',
        timeout: 5000
      });
      
      const lines = output.trim().split('\n');
      if (lines.length > 0 && lines[0]) {
        const [deviceName, vramStr] = lines[0].split(',').map(s => s.trim());
        const vramMB = parseInt(vramStr, 10);
        
        console.log(`🎮 NVIDIA GPU detected: ${deviceName} (${vramMB}MB VRAM)`);
        return { detected: true, vramMB, deviceName };
      }
    }
  } catch (error) {
    // nvidia-smi not available or failed
  }
  
  return { detected: false, vramMB: 0, deviceName: '' };
}

/**
 * Check if Vulkan is available with full SDK support
 * node-llama-cpp requires not just Vulkan runtime, but also the SDK (glslc compiler)
 */
function detectVulkan(): { detected: boolean; deviceName: string } {
  try {
    if (os.platform() === 'linux') {
      // Check if glslc (GLSL compiler) is available - REQUIRED for node-llama-cpp
      try {
        execSync('which glslc', { encoding: 'utf-8', timeout: 5000 });
      } catch {
        // glslc not found - Vulkan SDK not properly installed
        console.log('⚠️  Vulkan runtime detected, but glslc compiler not found');
        console.log('⚠️  Vulkan SDK required for compilation is not available');
        return { detected: false, deviceName: '' };
      }
      
      // Additional check: try to get GPU info
      const output = execSync('vulkaninfo --summary 2>/dev/null || true', {
        encoding: 'utf-8',
        timeout: 5000
      });
      
      if (output && output.includes('GPU')) {
        console.log('🎮 Vulkan SDK detected with glslc compiler');
        return { detected: true, deviceName: 'Vulkan GPU' };
      }
    }
  } catch (error) {
    // Vulkan not available or not fully installed
    console.log('⚠️  Vulkan SDK not available');
  }
  
  return { detected: false, deviceName: '' };
}

/**
 * Calculate optimal GPU layers based on VRAM and model size
 * This is a heuristic: typically 1 layer ≈ 20-50MB for quantized models
 */
function calculateGpuLayers(vramMB: number, modelSizeMB?: number): number | 'auto' {
  if (vramMB === 0) {
    return 0;
  }
  
  // Reserve some VRAM for context and overhead (typically 20-30%)
  const availableForLayers = Math.floor(vramMB * 0.7);
  
  // If we don't know model size, use auto
  if (!modelSizeMB) {
    return 'auto';
  }
  
  // Estimate: if model fits entirely in GPU, use all layers
  // Otherwise, calculate proportionally
  const layerSizeMB = modelSizeMB / 100; // Approximate: 100 layers in a model
  const maxLayers = Math.floor(availableForLayers / layerSizeMB);
  
  return Math.max(0, Math.min(maxLayers, 100));
}

/**
 * Detect available GPU and return optimal configuration
 */
export function detectGpu(modelSizeMB?: number): IGpuDetectionResult {
  console.log('🔍 Detecting GPU...');
  
  // Try NVIDIA CUDA first
  const nvidia = detectNvidiaGpu();
  if (nvidia.detected) {
    return {
      gpuType: 'cuda',
      gpuLayers: calculateGpuLayers(nvidia.vramMB, modelSizeMB),
      vramMB: nvidia.vramMB,
      deviceName: nvidia.deviceName
    };
  }
  
  // Try Vulkan
  const vulkan = detectVulkan();
  if (vulkan.detected) {
    return {
      gpuType: 'vulkan',
      gpuLayers: 'auto',
      vramMB: 0, // Unknown without more detailed query
      deviceName: vulkan.deviceName
    };
  }
  
  // Fallback to CPU
  console.log('⚠️  No GPU detected, using CPU mode');
  return {
    gpuType: 'cpu',
    gpuLayers: 0,
    vramMB: 0,
    deviceName: 'CPU'
  };
}

/**
 * Get recommended GPU setting for node-llama-cpp
 */
export function getGpuConfig(modelSizeMB?: number): { 
  gpu: 'cuda' | 'vulkan' | false;
  gpuLayers: number | 'auto';
} {
  const detection = detectGpu(modelSizeMB);
  
  if (detection.gpuType === 'cuda') {
    return { gpu: 'cuda', gpuLayers: detection.gpuLayers };
  }
  
  if (detection.gpuType === 'vulkan') {
    return { gpu: 'vulkan', gpuLayers: detection.gpuLayers };
  }
  
  return { gpu: false, gpuLayers: 0 };
}
