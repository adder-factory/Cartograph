// C# test bed
using System;
using System.Collections.Generic;

namespace TestBed {
    public class Box<T> { public T Value { get; set; } }

    public class Container<T> {
        private List<Box<T>> items = new List<Box<T>>();
        public void Add(Box<T> item) => this.items.Add(item);
        public int Size() => this.items.Count;
    }

    public static class Helper {
        public static void Log(object o) => Console.WriteLine(o);
    }

    public static class Main {
        public static Container<string> Process(Box<string> input) {
            var c = new Container<string>();
            c.Add(input);
            Helper.Log(c);
            return c;
        }
    }
}
