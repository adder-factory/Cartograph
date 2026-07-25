package demo

import java.time.Instant

enum Mood {
    HAPPY,
    SAD
}

interface Salutation {
    String greet(String other)
}

/** Greets callers. */
class Greeter extends Base implements Salutation {
    String name

    Greeter(String name) {
        this.name = name
    }

    String greet(String other) {
        helper(other)
        this.name.toString()
    }

    private String helper(String value) {
        value.toString()
    }
}

def topLevel(value) {
    def widget = new Widget()
    value.toString()
}
