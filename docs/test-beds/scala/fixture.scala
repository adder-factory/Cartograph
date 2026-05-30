// Scala test bed
package testbed

case class Box[T](value: T)

class Container[T] {
  private val items: scala.collection.mutable.ListBuffer[Box[T]] = scala.collection.mutable.ListBuffer()
  def add(item: Box[T]): Unit = items += item
  def size: Int = items.length
}

object Helper {
  def log(o: Any): Unit = println(o)
}

object Main {
  def process(input: Box[String]): Container[String] = {
    val c = new Container[String]()
    c.add(input)
    Helper.log(c)
    c
  }
}
