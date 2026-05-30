// Dart test bed
import 'helper.dart';

class Box<T> {
  T value;
  Box(this.value);
}

class Container<T> {
  final List<Box<T>> _items = [];
  void add(Box<T> item) { _items.add(item); }
  int size() => _items.length;
}

Container<String> process(Box<String> input) {
  final c = Container<String>();
  c.add(input);
  Helper.log(c);
  return c;
}

const int FOO = 42;
