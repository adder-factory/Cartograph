// Swift test bed
import Foundation

struct Box<T> {
    let value: T
}

class Container<T> {
    private var items: [Box<T>] = []
    func add(_ item: Box<T>) { items.append(item) }
    func size() -> Int { return items.count }
}

class Helper {
    static func log(_ o: Any) { print(o) }
}

func process(_ input: Box<String>) -> Container<String> {
    let c = Container<String>()
    c.add(input)
    Helper.log(c)
    return c
}

let FOO: Int = 42
