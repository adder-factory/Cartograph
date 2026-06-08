struct Light {
  vec3 position;
  float intensity;
};

float shade(float amount) {
  return amount * 0.5;
}

void main() {
  float value = shade(1.0);
}
