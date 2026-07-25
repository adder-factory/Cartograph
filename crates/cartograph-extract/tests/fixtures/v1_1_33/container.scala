package testbed

import scala.collection.mutable.ListBuffer

/** Runs container work. */
trait Runner extends AutoCloseable {
  def run(value: String): Result
}

case class Box[T](value: T)

/** Stores typed boxes. */
class Container[T](private val seed: Box[T]) extends Base with Runner {
  private val items: ListBuffer[Box[T]] = new ListBuffer[Box[T]]()

  def add(item: Box[T]): Unit = items.addOne(item)

  def size: Int = items.length
}

enum State {
  case Ready, Failed
}

object Helper {
  def log(value: Any): Unit = println(value)
}

type Name = String

def build(input: Box[String]): Container[String] = {
  val container = new Container[String](input)
  container.add(input)
  Helper.log(container)
  container
}
