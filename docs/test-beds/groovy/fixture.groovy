package demo

import java.time.Instant

class Greeter {
  String name

  Greeter(String name) {
    this.name = name
  }

  String greet(String other) {
    return helper(other)
  }

  private String helper(String other) {
    return "${name} ${other}"
  }
}

def topLevel(value) {
  return value.toString()
}
