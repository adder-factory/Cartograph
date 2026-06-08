#include <cuda_runtime.h>

__global__ void fillKernel(float *out) {
  int idx = threadIdx.x;
  out[idx] = 1.0f;
}

void launchFill(float *out) {
  fillKernel<<<1, 32>>>(out);
  cudaDeviceSynchronize();
}
