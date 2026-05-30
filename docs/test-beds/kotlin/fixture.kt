// Kotlin test bed
package testbed

import kotlin.collections.ArrayList

data class Box<T>(val value: T)

class Container<T> {
    private val items = ArrayList<Box<T>>()
    fun add(item: Box<T>) { items.add(item) }
    fun size(): Int = items.size
}

object Helper {
    fun log(o: Any) { println(o) }
}

fun process(input: Box<String>): Container<String> {
    val c = Container<String>()
    c.add(input)
    Helper.log(c)
    return c
}

const val FOO: Int = 42
