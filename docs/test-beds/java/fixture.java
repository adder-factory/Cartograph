// Java test bed
package testbed;

import java.util.ArrayList;
import java.util.List;

public class Container<T> {
    private List<Box<T>> items = new ArrayList<>();
    public void add(Box<T> item) { this.items.add(item); }
    public int size() { return this.items.size(); }
}

class Box<T> {
    public T value;
    public Box(T value) { this.value = value; }
}

class Helper {
    public static void log(Object o) { System.out.println(o); }
}

class Main {
    public static Container<String> process(Box<String> input) {
        Container<String> c = new Container<>();
        c.add(input);
        Helper.log(c);
        return c;
    }
}
